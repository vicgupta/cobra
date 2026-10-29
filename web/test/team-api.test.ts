// Team API (/api/v1/teams/{teamId}/repos/{repoId}/...): keys, ingress checks, scoping, CRUD, run instantiation.
// Runs use simulated mode with the builtin handlers (no real engine is launched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { openDb, type DB } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { createKey, revokeKey, canManageKeys, hashKey, listKeys, resolveKey, KeyError, KEY_RE } from "../lib/team-api/keys";
import { handle, bearer, API_LIMITS, type ApiReq } from "../lib/team-api/service";
import { createLesson, reviewLesson, type Actor } from "../lib/lessons/store";
import { createSkill } from "../lib/skills/store";
import { builtinHandlers } from "../lib/workflows/handlers";
import { checkTeamRepo } from "../lib/repos";
import type { RunDeps } from "../lib/workflows/service";
import { proxy } from "../proxy";

const T0 = Date.UTC(2026, 9, 29, 12);
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: Actor["role"], tenant = "acme"): Actor => {
    const id = createUser(db, { email, tenant, tenantName: `Team ${tenant}`, role, password: "pw-1234567890" });
    return { id, email, role, tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t };
  };
  const lead = mk("lead@acme.com", "team_lead"), member = mk("member@acme.com", "member"), admin = mk("admin@acme.com", "admin");
  const bLead = mk("lead@bee.com", "team_lead", "bee");
  const repo = (t: number, r: string) => Number(db.prepare("INSERT INTO team_repos (tenant_id, repo, created_at) VALUES (?, ?, ?)").run(t, r, T0).lastInsertRowid);
  const r1 = repo(lead.tenantId, "acme/api"), r2 = repo(lead.tenantId, "acme/web"), rb = repo(bLead.tenantId, "bee/app");
  const k1 = createKey(db, lead, { repoId: r1, name: "ci" }, T0), k2 = createKey(db, lead, { repoId: r2, name: "web" }, T0), kb = createKey(db, bLead, { repoId: rb, name: "bee" }, T0);
  return { db, lead, member, admin, bLead, r1, r2, rb, k1, k2, kb };
}
type S = ReturnType<typeof setup>;
const deps = (db: DB) => (t: number): RunDeps => ({ handlers: builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, t, r) }), resolveSecret: () => undefined, redact: () => [] });
let ip = 0;
function call(s: S, key: string | null, team: number, repo: number, method: string, path: string, body?: unknown, now = T0 + 1000) {
  const r: ApiReq = { method, teamId: String(team), repoId: String(repo), path: path.split("/").filter(Boolean), auth: key === null ? null : `Bearer ${key}`, ip: `10.0.0.${++ip % 250}`, body };
  return handle(s.db, r, deps(s.db), now);
}
const A = (s: S, method: string, path: string, body?: unknown) => call(s, s.k1.plaintext, s.lead.tenantId, s.r1, method, path, body);
const B = (s: S, method: string, path: string, body?: unknown) => call(s, s.k2.plaintext, s.lead.tenantId, s.r2, method, path, body);
const body = <T = Record<string, any>>(r: { body: unknown }) => r.body as T; // eslint-disable-line @typescript-eslint/no-explicit-any
const mkSkill = (s: S, f = A, name = "deploy-notes") => body(f(s, "POST", "skills", { name, description: "d", body: "# Notes\n\nWrite notes." })).skill;
const mkAgent = (s: S, f = A, name = "builder") => body(f(s, "POST", "agents", { name, engine: "claude-code", prompt: "Build it." })).agent;

// ---------- migration ----------
test("migration 36: api_keys/api_objects/api_runs/api_audit tables", () => {
  const { db } = setup();
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 36);
  for (const t of ["api_keys", "api_objects", "api_runs", "api_audit"]) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
});

// ---------- keys ----------
test("keys: plaintext shown once, only sha256 + prefix stored", () => {
  const s = setup();
  assert.match(s.k1.plaintext, KEY_RE);
  const row = s.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(s.k1.key.id) as Record<string, unknown>;
  assert.equal(row.key_hash, hashKey(s.k1.plaintext));
  assert.equal(row.prefix, s.k1.plaintext.slice(0, 12));
  const dump = JSON.stringify(s.db.prepare("SELECT * FROM api_keys").all()) + JSON.stringify(s.db.prepare("SELECT * FROM api_audit").all());
  for (const k of [s.k1, s.k2, s.kb]) assert.ok(!dump.includes(k.plaintext), "no plaintext in DB");
  assert.ok(!JSON.stringify(listKeys(s.db, s.lead.tenantId)).includes(s.k1.plaintext));
});
test("keys: only the team lead / designated lead can create; members and non-lead admins get 403", () => {
  const s = setup();
  for (const u of [s.member, s.admin]) {
    assert.equal(canManageKeys(s.db, u), false);
    assert.throws(() => createKey(s.db, u, { repoId: s.r1, name: "x" }), (e) => e instanceof KeyError && e.status === 403);
  }
  s.db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(s.member.id, s.member.tenantId);
  assert.equal(canManageKeys(s.db, s.member), true);
  assert.ok(createKey(s.db, s.member, { repoId: s.r1, name: "by designated lead" }).plaintext);
});
test("keys: repo must belong to the lead's team; name validated", () => {
  const s = setup();
  assert.throws(() => createKey(s.db, s.lead, { repoId: s.rb, name: "x" }), (e) => e instanceof KeyError && e.status === 404);
  assert.throws(() => createKey(s.db, s.lead, { repoId: s.r1, name: "" }), (e) => e instanceof KeyError && e.status === 400);
});
test("keys: revoke → 401; cross-team revoke 404; member revoke 403; last_used_at tracked", () => {
  const s = setup();
  assert.equal(A(s, "GET", "skills").status, 200);
  assert.ok((s.db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").get(s.k1.key.id) as { last_used_at: number }).last_used_at);
  assert.throws(() => revokeKey(s.db, s.bLead, s.k1.key.id), (e) => e instanceof KeyError && e.status === 404);
  assert.throws(() => revokeKey(s.db, s.member, s.k1.key.id), (e) => e instanceof KeyError && e.status === 403);
  assert.ok(revokeKey(s.db, s.lead, s.k1.key.id).revokedAt);
  assert.equal(A(s, "GET", "skills").status, 401);
  assert.equal(resolveKey(s.db, s.k1.plaintext), null);
});

// ---------- auth ----------
test("auth: 401 missing/bogus/malformed; 403 team or repo mismatch", () => {
  const s = setup();
  assert.equal(call(s, null, s.lead.tenantId, s.r1, "GET", "skills").status, 401);
  assert.equal(call(s, "cbk_" + "A".repeat(43), s.lead.tenantId, s.r1, "GET", "skills").status, 401);
  assert.equal(call(s, "nope", s.lead.tenantId, s.r1, "POST", "runs", {}).status, 401);
  assert.equal(bearer("Basic abc"), null);
  assert.equal(call(s, s.k1.plaintext, s.bLead.tenantId, s.rb, "GET", "skills").status, 403, "other team");
  assert.equal(call(s, s.k1.plaintext, s.lead.tenantId, s.r2, "GET", "skills").status, 403, "other repo same team");
  assert.equal(call(s, s.kb.plaintext, s.lead.tenantId, s.r1, "GET", "agents").status, 403);
});
test("auth: key stops working when its creator is no longer a lead", () => {
  const s = setup();
  s.db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(s.lead.id);
  assert.equal(A(s, "GET", "skills").status, 401);
});
test("auth: 429 after too many bad-key attempts from one IP, and per-key limit", () => {
  const s = setup();
  let last = 0;
  for (let i = 0; i <= API_LIMITS.authFail.max; i++) last = handle(s.db, { method: "GET", teamId: "1", repoId: "1", path: ["skills"], auth: "Bearer bad", ip: "9.9.9.9", body: undefined }, deps(s.db), T0).status;
  assert.equal(last, 429);
  for (let i = 0; i <= API_LIMITS.key.max; i++) last = A(s, "GET", "skills").status;
  assert.equal(last, 429);
});
test("405: run DELETE, unsupported methods, Allow header", () => {
  const s = setup();
  const r = body(A(s, "POST", "runs", { engine: "claude-code", prompt: "hi", start: false })).run;
  const d = A(s, "DELETE", `runs/${r.id}`);
  assert.equal(d.status, 405); assert.equal(d.headers?.Allow, "GET, PUT");
  assert.equal(A(s, "DELETE", "runs").status, 405);
  assert.equal(A(s, "PATCH", "skills").status, 405);
  assert.equal(A(s, "GET", `runs/${r.id}/start`).status, 405);
  assert.equal(s.db.prepare("SELECT COUNT(*) c FROM api_runs").get()!.c, 1, "run not deleted");
  assert.equal(A(s, "GET", "nothing").status, 404);
});

// ---------- isolation ----------
test("isolation: skills of another repo/team are 404 for GET/PUT/DELETE/run; UI skills invisible", () => {
  const s = setup();
  const sk = mkSkill(s);
  const ui = createSkill(s.db, s.lead, { name: "ui-skill", description: "d", body: "# UI\n\nx" });
  for (const [m, p] of [["GET", `skills/${sk.id}`], ["PUT", `skills/${sk.id}`], ["DELETE", `skills/${sk.id}`], ["POST", `skills/${sk.id}/run`]] as const) {
    assert.equal(B(s, m, p, {}).status, 404, `cross-repo ${m} ${p}`);
    assert.equal(call(s, s.kb.plaintext, s.bLead.tenantId, s.rb, m, p, {}).status, 404, `cross-team ${m} ${p}`);
  }
  assert.equal(A(s, "GET", `skills/${ui.id}`).status, 404);
  assert.equal(body(B(s, "GET", "skills")).skills.length, 0);
  assert.equal(B(s, "POST", "runs", { skillId: sk.id }).status, 404);
});
test("isolation: agents of another repo/team are 404; agents can't reference out-of-scope skills or other repos", () => {
  const s = setup();
  const ag = mkAgent(s);
  for (const [m, p] of [["GET", `agents/${ag.id}`], ["PUT", `agents/${ag.id}`], ["DELETE", `agents/${ag.id}`], ["POST", `agents/${ag.id}/run`]] as const) {
    assert.equal(B(s, m, p, {}).status, 404, `cross-repo ${m} ${p}`);
    assert.equal(call(s, s.kb.plaintext, s.bLead.tenantId, s.rb, m, p, {}).status, 404, `cross-team ${m} ${p}`);
  }
  assert.equal(B(s, "POST", "runs", { agentId: ag.id }).status, 404);
  const sk = mkSkill(s);
  assert.equal(B(s, "POST", "agents", { name: "x", engine: "claude-code", prompt: "p", skillId: sk.id }).status, 404);
  assert.equal(A(s, "POST", "agents", { name: "y", engine: "claude-code", prompt: "p", defaultRepo: "acme/web" }).status, 400);
});
test("isolation: runs of another repo/team are 404 for GET/PUT/start", () => {
  const s = setup();
  const r = body(A(s, "POST", "runs", { engine: "claude-code", prompt: "hi" })).run;
  for (const id of [r.id, r.runId]) for (const [m, p] of [["GET", `runs/${id}`], ["PUT", `runs/${id}`], ["POST", `runs/${id}/start`], ["POST", `runs/${id}/instantiate`]] as const) {
    assert.equal(B(s, m, p, {}).status, 404);
    assert.equal(call(s, s.kb.plaintext, s.bLead.tenantId, s.rb, m, p, {}).status, 404);
  }
  assert.equal(body(B(s, "GET", "runs")).runs.length, 0);
});

// ---------- CRUD ----------
test("CRUD: skills create/list/get/update/delete with skill_audit + api_audit (key id)", () => {
  const s = setup();
  const sk = mkSkill(s);
  assert.ok(sk.id);
  assert.equal(body(A(s, "GET", "skills")).skills.length, 1);
  assert.equal(body(A(s, "GET", `skills/${sk.id}`)).skill.name, "deploy-notes");
  assert.equal(A(s, "PUT", `skills/${sk.id}`, { description: "new" }).status, 200);
  assert.equal(body(A(s, "GET", `skills/${sk.id}`)).skill.description, "new");
  assert.equal(A(s, "POST", "skills", { name: "BAD NAME" }).status, 400);
  assert.equal(A(s, "DELETE", `skills/${sk.id}`).status, 200);
  assert.equal(A(s, "GET", `skills/${sk.id}`).status, 404);
  const au = s.db.prepare("SELECT key_id, action, status FROM api_audit WHERE key_id = ? ORDER BY id").all(s.k1.key.id) as Array<{ action: string; status: number }>;
  assert.ok(au.some((a) => a.action === "POST skills" && a.status === 201));
  assert.ok(au.some((a) => a.action === "PUT skills" && a.status === 200));
  assert.ok(au.some((a) => a.action === "DELETE skills" && a.status === 200));
  assert.ok(au.some((a) => a.status === 400), "failed writes audited too");
});
test("CRUD: agents create (repo forced to key repo)/get/update/delete with agent_audit rows naming the key", () => {
  const s = setup();
  const ag = mkAgent(s);
  assert.equal(ag.defaultRepo, "acme/api");
  assert.equal(A(s, "PUT", `agents/${ag.id}`, { prompt: "Build better." }).status, 200);
  assert.equal(body(A(s, "GET", `agents/${ag.id}`)).agent.prompt, "Build better.");
  assert.equal(A(s, "DELETE", `agents/${ag.id}`).status, 200);
  assert.equal(A(s, "GET", `agents/${ag.id}`).status, 404);
  const acts = (s.db.prepare("SELECT action, detail FROM agent_audit WHERE action LIKE 'api_agent_%'").all() as Array<{ action: string; detail: string }>);
  assert.deepEqual(acts.map((a) => a.action), ["api_agent_create", "api_agent_update", "api_agent_delete"]);
  assert.ok(acts.every((a) => a.detail.includes(`key #${s.k1.key.id}`)));
});

// ---------- runs ----------
test("runs: POST /runs with agentId and skillId instantiate real run records on the key's repo", () => {
  const s = setup();
  const ag = mkAgent(s), sk = mkSkill(s);
  for (const b of [{ agentId: ag.id, prompt: "do it" }, { skillId: sk.id, prompt: "notes please" }]) {
    const r = A(s, "POST", "runs", b);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const run = body(r).run;
    assert.equal(run.status, "started"); assert.ok(run.runId);
    const row = s.db.prepare("SELECT tenant_id, repo FROM runs WHERE id = ?").get(run.runId) as { tenant_id: number; repo: string };
    assert.equal(row.tenant_id, s.lead.tenantId); assert.equal(row.repo, "acme/api");
  }
});
test("runs: /skills/{id}/run and /agents/{id}/run shortcuts", () => {
  const s = setup();
  const ag = mkAgent(s), sk = mkSkill(s);
  assert.equal(body(A(s, "POST", `agents/${ag.id}/run`, { prompt: "x" })).run.kind, "agent");
  assert.equal(body(A(s, "POST", `skills/${sk.id}/run`, {})).run.kind, "skill");
  assert.equal(s.db.prepare("SELECT COUNT(*) c FROM api_runs WHERE status = 'started'").get()!.c, 2);
});
test("runs: pending run starts in place; re-run creates a NEW id and leaves history unchanged", () => {
  const s = setup();
  const p = body(A(s, "POST", "runs", { engine: "claude-code", prompt: "later", start: false })).run;
  assert.equal(p.status, "pending"); assert.equal(p.runId, null);
  const started = body(A(s, "POST", `runs/${p.id}/start`, {})).run;
  assert.equal(started.id, p.id); assert.equal(started.status, "started");
  const again = body(A(s, "POST", `runs/${p.id}/instantiate`, {})).run;
  assert.notEqual(again.id, p.id); assert.notEqual(again.runId, started.runId); assert.equal(again.rerunOf, p.id);
  assert.equal(body(A(s, "GET", `runs/${p.id}`)).run.runId, started.runId, "original unchanged");
  assert.equal(body(A(s, "GET", `runs/${started.runId}`)).run.id, p.id, "addressable by run id");
});
test("runs: PUT meta always, prompt only while pending, cancel pending only", () => {
  const s = setup();
  const p = body(A(s, "POST", "runs", { engine: "claude-code", prompt: "a", start: false })).run;
  assert.equal(body(A(s, "PUT", `runs/${p.id}`, { prompt: "b", meta: { ticket: 7 } })).run.prompt, "b");
  assert.equal(body(A(s, "PUT", `runs/${p.id}`, { cancel: true })).run.status, "cancelled");
  const r = body(A(s, "POST", "runs", { engine: "claude-code", prompt: "c" })).run;
  assert.equal(A(s, "PUT", `runs/${r.id}`, { prompt: "d" }).status, 409);
  assert.equal(A(s, "PUT", `runs/${r.id}`, { cancel: true }).status, 409);
  assert.deepEqual(body(A(s, "PUT", `runs/${r.id}`, { meta: { x: 1 } })).run.meta, { x: 1 });
  assert.equal(A(s, "POST", "runs", { prompt: "no target" }).status, 400);
  assert.equal(A(s, "POST", "runs", { engine: "claude-code", prompt: "x".repeat(4001) }).status, 400);
});
test("runs: approved lessons are injected into API runs (agent + engine)", () => {
  const s = setup();
  const l = createLesson(s.db, s.lead, { title: "Lint first", whatHappened: "CI failed on lint.", whatWeLearned: "Run the linter before pushing.", repo: "acme/api", tags: ["lint"], confidence: "high" });
  reviewLesson(s.db, s.lead, l.id, "approve");
  const ag = mkAgent(s);
  for (const b of [{ agentId: ag.id, prompt: "fix lint" }, { engine: "claude-code", prompt: "fix lint errors" }]) {
    const run = body(A(s, "POST", "runs", b)).run;
    assert.ok(run.injectedLessons.includes(l.id), JSON.stringify(run));
  }
  assert.equal(body(B(s, "POST", "runs", { engine: "claude-code", prompt: "fix lint" })).run.injectedLessons.length, 0, "other repo's lesson not injected");
});
test("runs: run limit per key returns 429", () => {
  const s = setup();
  let last = 0;
  for (let i = 0; i <= API_LIMITS.runs.max; i++) last = call(s, s.k1.plaintext, s.lead.tenantId, s.r1, "POST", "runs", { engine: "claude-code", prompt: "x" }, T0 + i * 1000).status;
  assert.equal(last, 429);
});

// ---------- wiring ----------
test("proxy lets /api/v1 through without a session cookie; other /api still 401", async () => {
  const r = await proxy(new NextRequest("http://x/api/v1/teams/1/repos/1/skills"));
  assert.notEqual(r.status, 401);
  assert.equal((await proxy(new NextRequest("http://x/api/lessons"))).status, 401);
});
test("source: keys never logged; ingress route has no console calls", () => {
  for (const f of ["lib/team-api/keys.ts", "lib/team-api/service.ts", "app/api/v1/teams/[teamId]/repos/[repoId]/[[...path]]/route.ts", "app/api/team/api-keys/route.ts"])
    assert.ok(!/console\./.test(readFileSync(f, "utf8")), f);
});

// ---------- docs ----------
const ROUTES: Array<[string, string]> = [
  ["GET", "/skills"], ["POST", "/skills"], ["GET", "/skills/{id}"], ["PUT", "/skills/{id}"], ["DELETE", "/skills/{id}"], ["POST", "/skills/{id}/run"],
  ["GET", "/agents"], ["POST", "/agents"], ["GET", "/agents/{id}"], ["PUT", "/agents/{id}"], ["DELETE", "/agents/{id}"], ["POST", "/agents/{id}/run"],
  ["GET", "/runs"], ["POST", "/runs"], ["GET", "/runs/{id}"], ["PUT", "/runs/{id}"], ["DELETE", "/runs/{id}"], ["POST", "/runs/{id}/start"], ["POST", "/runs/{id}/instantiate"],
];
test("docs: every implemented route is in docs/api.md (table + section + curl), and each is really served", () => {
  const md = readFileSync("../docs/api.md", "utf8");
  for (const [m, p] of ROUTES) {
    const s = setup();
    const sk = mkSkill(s), ag = mkAgent(s), run = body(A(s, "POST", "runs", { engine: "claude-code", prompt: "x", start: false })).run;
    assert.ok(md.includes(`| ${m} | \`${p}\``), `table row ${m} ${p}`);
    assert.ok(md.includes(`### ${m} ${p}`) || (p.endsWith("/instantiate") && md.includes("alias /instantiate")), `section ${m} ${p}`);
    const curlPath = p.replace("{id}", "");
    assert.ok(md.split("\n").some((l) => l.includes("curl") && (m === "GET" || l.includes(`-X ${m}`)) && l.includes(`$BASE${curlPath.split("/").slice(0, 2).join("/")}`)), `curl ${m} ${p}`);
    const id = p.startsWith("/skills") ? sk.id : p.startsWith("/agents") ? ag.id : run.id;
    const st = A(s, m, p.slice(1).replace("{id}", String(id)), {}).status;
    assert.notEqual(st, 404, `${m} ${p} served`);
  }
  assert.ok(!/cbk_[A-Za-z0-9_-]{43}/.test(md), "no real-looking keys in docs");
  for (const h of ["Team confinement", "Generate (team leads only)", "Revoke", "Rate limits", "Audit", "How lessons apply", "Changelog", "Authorization: Bearer"]) assert.ok(md.includes(h), h);
  assert.match(readFileSync("../README.md", "utf8"), /docs\/api\.md/);
  assert.match(readFileSync("app/docs/api/page.tsx", "utf8"), /AuthGate/);
});

test("base path: GET returns key info (team, repo, endpoints); other methods 405; no key 401; mismatch 403 names the key's base", () => {
  const s = setup();
  const r = A(s, "GET", "");
  assert.equal(r.status, 200);
  const b = body(r);
  assert.equal(b.team.id, s.lead.tenantId); assert.equal(b.repo.id, s.r1);
  assert.ok(b.key.prefix.startsWith("cbk_")); assert.equal(JSON.stringify(b).includes(s.k1.plaintext), false);
  assert.deepEqual(b.endpoints, ["skills", "agents", "runs"].map((x) => `/api/v1/teams/${s.lead.tenantId}/repos/${s.r1}/${x}`));
  assert.equal(A(s, "POST", "").status, 405);
  assert.equal(call(s, null, s.lead.tenantId, s.r1, "GET", "").status, 401);
  const mm = call(s, s.k1.plaintext, s.lead.tenantId, s.r2, "GET", "");
  assert.equal(mm.status, 403); assert.match(body(mm).error, new RegExp(`/teams/${s.lead.tenantId}/repos/${s.r1}`));
  for (const x of ["skills", "agents", "runs"]) assert.equal(A(s, "GET", x).status, 200, x);
});
