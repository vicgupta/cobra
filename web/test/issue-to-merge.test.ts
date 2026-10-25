// Job 21: the built-in issue-to-merge workflow (issue -> PR -> merge) on the github
// issue_create / pr_from_issue / merge actions: simulated end to end, the merge rule,
// audit rows, and the per-repo token resolver on every step.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, checkTeamRepo, setRepoPat, tokenFor } from "../lib/repos";
import { builtinHandlers, type CollabHooks } from "../lib/workflows/handlers";
import { recordDecision } from "../lib/workflows/approvals";
import { getRunDetail, hasAgentStep } from "../lib/workflows/runner";
import { findWorkflow, listAll, type Actor } from "../lib/workflows/store";
import { startRun, type RunDeps } from "../lib/workflows/service";
import { audit, canMerge, listAudit, setDesignatedLead } from "../lib/collab";

const DIR = path.resolve(__dirname, "../../workflows");
const KEY = randomBytes(32).toString("base64");
const PAT = "ghp_REPOpatREPOpat0123456789abcd";
const SERVER = "server-GITHUB_TOKEN-value-123";
const REPO = "vicgupta/factory-demo-app", NOPAT = "vicgupta/nopat";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member") => {
    const id = createUser(db, { email, tenant: "team-a", tenantName: "team-a", role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const admin = mk("admin@a.com", "admin"), lead = mk("lead@a.com", "team_lead"), member = mk("member@a.com", "member");
  addTeamRepo(db, admin, REPO, "main");
  addTeamRepo(db, admin, NOPAT, "main");
  setRepoPat(db, admin, REPO, PAT, KEY);
  setDesignatedLead(db, admin, lead.id);
  const w = findWorkflow(db, admin.tenantId, "issue-to-merge-flow", DIR)!;
  assert.ok(w, "issue-to-merge is a built-in workflow");
  recordDecision(db, lead, w, "approve");
  return { db, admin, lead, member };
}

/** In-memory GitHub; records method, path, body and which token (label only) each call used. */
function fakeGh() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null; token: string }> = [];
  const items = new Map<number, Record<string, unknown>>();
  let next = 40;
  const f = (async (url: string, init: RequestInit) => {
    const p = url.replace("https://api.github.com/repos/", ""), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    const h = String((init.headers as Record<string, string>).authorization);
    calls.push({ method, path: p, body, token: h === `Bearer ${PAT}` ? "pat" : h === `Bearer ${SERVER}` ? "server" : "other" });
    const j = (s: number, v: unknown) => new Response(JSON.stringify(v), { status: s });
    let m;
    if (method === "POST" && /\/issues$/.test(p)) { const n = next++; items.set(n, { number: n, title: body.title, body: body.body, state: "open", html_url: `u/${n}` }); return j(201, items.get(n)); }
    if (method === "POST" && /\/pulls$/.test(p)) { const n = next++; items.set(n, { number: n, title: body.title, body: body.body, state: "open", merged: false, html_url: `u/${n}`, head: { ref: body.head, sha: "abc123" } }); return j(201, items.get(n)); }
    if ((m = /\/pulls\/(\d+)\/merge$/.exec(p)) && method === "PUT") { const x = items.get(+m[1])!; x.state = "closed"; x.merged = true; return j(200, { merged: true, sha: "deadbeefcafe0000" }); }
    if ((m = /\/(issues|pulls)\/(\d+)$/.exec(p)) && method === "GET") { const x = items.get(+m[2]); return x ? j(200, x) : j(404, { message: "Not Found" }); }
    if (/^[^/]+\/[^/]+$/.test(p)) return j(200, { default_branch: "main" });
    return j(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  return { f, calls, items };
}

function deps(db: ReturnType<typeof openDb>, u: Actor, f: typeof fetch, agentRuns: string[] = []): RunDeps {
  const hooks: CollabHooks = { canMerge: () => canMerge(db, u), who: u.email, audit: (a, r, n, id, d) => audit(db, u, a, r, n, id, d) };
  return {
    handlers: builtinHandlers({
      fetch: f, checkRepo: (r) => checkTeamRepo(db, u.tenantId, r), tokenFor: tokenFor(db, u.tenantId, KEY, SERVER), collab: hooks,
      agentRunner: async ({ runId, driver, with: w }) => { agentRuns.push(`${driver}:${String(w.repo)}:${String(w.prompt).split("\n")[0]}`); return { driver, branch: `cobra/${runId}`, pushed: true, summary: "Added the file." }; },
    }),
    resolveSecret: () => SERVER, redact: () => [PAT, SERVER],
  };
}

async function run(db: ReturnType<typeof openDb>, u: Actor, f: typeof fetch, body: Record<string, unknown>, agentRuns?: string[]) {
  const r = startRun(db, u, "issue-to-merge-flow", { inputs: { title: "Add HELLO.md", body: "Please add HELLO.md" }, ...body }, { ...deps(db, u, f, agentRuns), dir: DIR });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await r.run!.done;
  return getRunDetail(db, r.run!.id)!;
}
const stepsOf = (d: NonNullable<ReturnType<typeof getRunDetail>>) => Object.fromEntries(d.events.filter((e) => e.stepId !== "run" && ["succeeded", "failed", "skipped"].includes(e.status)).map((e) => [e.stepId, e.status]));

test("issue-to-merge is listed as a built-in workflow with three github steps that get engine/repo/mode", () => {
  const db = openDb(":memory:");
  const l = listAll(db, 1, DIR).find((x) => x.name === "issue-to-merge-flow" && x.origin === "repo");
  assert.ok(l?.loaded, JSON.stringify(l?.errors));
  assert.deepEqual(l!.loaded!.workflow.steps.map((s) => [s.id, s.uses, s.with.action]), [["issue", "github", "issue_create"], ["pr", "github", "pr_from_issue"], ["merge", "github", "merge"]]);
  assert.equal(hasAgentStep(l!.loaded!.workflow), true, "the PR step runs an agent, so the run form offers engine/repo/mode");
});

test("simulated end to end: no GitHub calls, no agent, no audit; succeeds for the designated lead", async () => {
  const { db, lead } = setup();
  const gh = fakeGh(), agents: string[] = [];
  const d = await run(db, lead, gh.f, { mode: "simulated", repo: REPO, engine: "codex" }, agents);
  assert.equal(d.status, "succeeded", d.error ?? "");
  assert.deepEqual(stepsOf(d), { issue: "succeeded", pr: "succeeded", merge: "succeeded" });
  assert.equal(gh.calls.length, 0);
  assert.equal(agents.length, 0);
  assert.equal(listAudit(db, lead.tenantId, REPO).length, 0);
});

test("real (fake GitHub) as the designated lead: issue, PR referencing it, plain sha-pinned merge, audit rows", async () => {
  const { db, lead } = setup();
  const gh = fakeGh(), agents: string[] = [];
  const d = await run(db, lead, gh.f, { mode: "real", repo: REPO, engine: "codex" }, agents);
  assert.equal(d.status, "succeeded", d.error ?? "");
  assert.deepEqual(d.outputs, { issue: 40, pr: 41, merge_sha: "deadbeefcafe0000" });
  assert.deepEqual(agents, [`codex:${REPO}:Resolve GitHub issue #40 in ${REPO}.`], "per-run engine override reaches the agent");
  const pr = gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
  assert.match(String(pr.body!.body), /^Closes #40\b/);
  assert.equal(pr.body!.base, "main");
  assert.match(String(pr.body!.head), /^cobra\//);
  const put = gh.calls.find((c) => c.method === "PUT")!;
  assert.deepEqual(put.body, { merge_method: "merge", sha: "abc123" }, "plain merge pinned to the head sha, no force");
  assert.deepEqual(listAudit(db, lead.tenantId, REPO).map((r) => [r.action, r.number, r.actorEmail]).sort(),
    [["issue_create", 40, "lead@a.com"], ["merge", 41, "lead@a.com"], ["pr_create", 40, "lead@a.com"], ["pr_create", 41, "lead@a.com"]]);
  assert.ok(listAudit(db, lead.tenantId, REPO).every((r) => r.runId === d.id));
});

test("a member is stopped at merge with a clear message; the PR stays open (simulated and real)", async () => {
  const { db, member, admin } = setup();
  const sim = await run(db, member, fakeGh().f, { mode: "simulated", repo: REPO });
  assert.equal(sim.status, "failed");
  assert.deepEqual(stepsOf(sim), { issue: "succeeded", pr: "succeeded", merge: "failed" });
  const gh = fakeGh();
  const d = await run(db, member, gh.f, { mode: "real", repo: REPO });
  assert.equal(d.status, "failed");
  assert.equal(d.error, "step(s) failed: merge");
  const steps = JSON.parse((db.prepare("SELECT steps_json s FROM runs WHERE id = ?").get(d.id) as { s: string }).s);
  assert.match(steps.merge.error, /merge not allowed: member@a\.com is not the team's designated lead or a system admin; PR #41 is left open/);
  assert.equal(gh.calls.filter((c) => c.method === "PUT").length, 0, "no merge call reached GitHub");
  assert.equal(gh.items.get(41)!.state, "open");
  assert.deepEqual(listAudit(db, admin.tenantId, REPO).map((r) => r.action).sort(), ["issue_create", "pr_create", "pr_create"]);
  // a system admin can merge
  const a = await run(db, admin, fakeGh().f, { mode: "real", repo: REPO });
  assert.equal(a.status, "succeeded", a.error ?? "");
});

test("token choice per step: repo PAT when set, else GITHUB_TOKEN; never both", async () => {
  const { db, lead } = setup();
  const g1 = fakeGh();
  assert.equal((await run(db, lead, g1.f, { mode: "real", repo: REPO })).status, "succeeded");
  assert.ok(g1.calls.length >= 5);
  assert.deepEqual([...new Set(g1.calls.map((c) => c.token))], ["pat"], "issue, PR and merge all used the repo's PAT");
  const g2 = fakeGh();
  const d2 = await run(db, lead, g2.f, { mode: "real", repo: NOPAT });
  assert.equal(d2.status, "succeeded", d2.error ?? "");
  assert.deepEqual([...new Set(g2.calls.map((c) => c.token))], ["server"], "no PAT: GITHUB_TOKEN on every step");
  assert.ok(!JSON.stringify(d2).includes(SERVER) && !JSON.stringify(getRunDetail(db, (await run(db, lead, fakeGh().f, { mode: "real", repo: REPO })).id)).includes(PAT), "tokens never in run records");
});
