// Job 15: issues and pull requests, the designated-lead merge gate and the audit trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, checkTeamRepo } from "../lib/repos";
import { createAgent } from "../lib/agents";
import { builtinHandlers } from "../lib/workflows/handlers";
import { getRunDetail } from "../lib/workflows/runner";
import type { Actor } from "../lib/workflows/store";
import type { RunDeps } from "../lib/workflows/service";
import { githubApi } from "../lib/github-api";
import { addComment, agentIssue, canMerge, CollabError, createIssue, createPrFromIssue, designatedLead, listAudit, mergePull, setDesignatedLead } from "../lib/collab";

const REPO = "vicgupta/factory-demo-app";
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  const admin = mk("admin@a.com", "admin", "team-a"), lead = mk("lead@a.com", "team_lead", "team-a"), lead2 = mk("lead2@a.com", "team_lead", "team-a"), member = mk("member@a.com", "member", "team-a");
  const b = mk("admin@b.com", "admin", "team-b"), bLead = mk("lead@b.com", "team_lead", "team-b");
  addTeamRepo(db, admin, REPO, "main");
  return { db, admin, lead, lead2, member, b, bLead };
}

/** In-memory GitHub: records calls, serves issues/pulls. */
function fakeGh() {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  let next = 10;
  const items = new Map<number, Record<string, unknown>>();
  const f = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.github.com", ""), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    assert.match(String((init.headers as Record<string, string>).Authorization), /^Bearer /);
    calls.push({ method, path, body });
    const j = (s: number, v: unknown) => new Response(JSON.stringify(v), { status: s });
    let m;
    if (method === "POST" && /\/issues$/.test(path)) { const n = next++; const i = { number: n, title: body.title, body: body.body, state: "open", html_url: `u/${n}`, user: { login: "bot" }, created_at: "", comments: 0 }; items.set(n, i); return j(201, i); }
    if (method === "POST" && /\/pulls$/.test(path)) { const n = next++; const p = { number: n, title: body.title, body: body.body, state: "open", html_url: `u/${n}`, user: { login: "bot" }, created_at: "", merged: false, merged_at: null, head: { ref: body.head, sha: "abc123" }, base: { ref: body.base } }; items.set(n, p); return j(201, p); }
    if ((m = /\/issues\/(\d+)\/comments$/.exec(path)) && method === "POST") return j(201, { id: 1, body: body.body, user: null, created_at: "", html_url: `c/${m[1]}` });
    if ((m = /\/(issues|pulls)\/(\d+)$/.exec(path)) && method === "GET") { const i = items.get(+m[2]); return i ? j(200, i) : j(404, { message: "Not Found" }); }
    if ((m = /\/pulls\/(\d+)\/merge$/.exec(path)) && method === "PUT") { const p = items.get(+m[1])!; p.state = "closed"; p.merged = true; return j(200, { merged: true, sha: "deadbeefcafe0000", message: "merged" }); }
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return j(200, { default_branch: "main" });
    return j(404, { message: "Not Found" });
  }) as unknown as typeof fetch;
  return { gh: githubApi("test-token", f), calls, items, seedPull: (n: number) => items.set(n, { number: n, title: "t", body: "", state: "open", html_url: "", user: null, created_at: "", merged: false, merged_at: null, head: { ref: "cobra/x", sha: "abc123" }, base: { ref: "main" } }) };
}
const deps = (db: ReturnType<typeof openDb>, t: number, pushed = true): RunDeps => ({
  handlers: builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, t, r), agentRunner: async ({ runId, driver, with: w }) => ({ driver, branch: `cobra/${runId}`, pushed, summary: `Fixed it. Prompt was: ${String(w.prompt).slice(0, 40)}` }) }),
  resolveSecret: () => undefined, redact: () => [],
});
const status = (s: number) => (e: unknown) => e instanceof CollabError && e.status === s;

test("merge gate: member and non-designated lead get 403; designated lead and system admin can merge", async () => {
  const { db, admin, lead, lead2, member, b } = setup();
  const { gh, calls, seedPull } = fakeGh();
  seedPull(1); seedPull(2); seedPull(3);
  assert.equal(canMerge(db, lead), false, "no designated lead yet");
  await assert.rejects(mergePull(db, gh, member, REPO, 1), status(403));
  await assert.rejects(mergePull(db, gh, lead, REPO, 1), status(403));
  // only system admins pick the designated lead, and only from this team's team leads
  assert.throws(() => setDesignatedLead(db, lead, lead.id), status(403));
  assert.throws(() => setDesignatedLead(db, admin, member.id), status(400));
  assert.throws(() => setDesignatedLead(db, admin, b.id), status(400));
  assert.deepEqual(setDesignatedLead(db, admin, lead.id), { id: lead.id, email: lead.email });
  assert.equal(designatedLead(db, b.tenantId), null, "other teams unaffected");
  await assert.rejects(mergePull(db, gh, lead2, REPO, 1), status(403), "another team lead still can't merge");
  await assert.rejects(mergePull(db, gh, member, REPO, 1), status(403));
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "no merge call reached GitHub");
  assert.deepEqual(await mergePull(db, gh, lead, REPO, 1), { merged: true, sha: "deadbeefcafe0000", base: "main" });
  const put = calls.find((c) => c.method === "PUT")!;
  assert.deepEqual(put.body, { merge_method: "merge", sha: "abc123" }, "plain merge pinned to the head sha, no force");
  assert.deepEqual(await mergePull(db, gh, admin, REPO, 2), { merged: true, sha: "deadbeefcafe0000", base: "main" });
  await assert.rejects(mergePull(db, gh, admin, REPO, 1), status(409), "already merged");
  await assert.rejects(mergePull(db, gh, b, REPO, 3), status(404), "other team's repo");
  const a = listAudit(db, admin.tenantId, REPO);
  assert.deepEqual(a.filter((r) => r.action === "merge").map((r) => [r.actorEmail, r.number]).sort(), [["admin@a.com", 2], ["lead@a.com", 1]]);
  setDesignatedLead(db, admin, null);
  await assert.rejects(mergePull(db, gh, lead, REPO, 3), status(403), "cleared designation removes rights");
});

test("issues, comments, agent issue and Create PR need no approval and write audit rows", async () => {
  const { db, member, admin, b } = setup();
  const { gh, calls } = fakeGh();
  const i = await createIssue(db, gh, member, REPO, { title: "Broken button", body: "It does nothing" });
  assert.match(String(calls.at(-1)!.body!.body), /Created with Cobra by member@a.com/);
  await assert.rejects(createIssue(db, gh, member, REPO, { title: " " }), status(400));
  await assert.rejects(createIssue(db, gh, member, "other/repo", { title: "x" }), status(404));
  await assert.rejects(createIssue(db, gh, b, REPO, { title: "x" }), status(404), "team repos only");
  await addComment(db, gh, member, REPO, i.number, { body: "LGTM" });
  // agent writes an issue (simulated engine run)
  const ai = agentIssue(db, gh, member, REPO, { engine: "codex", prompt: "Find a bug", mode: "simulated" }, deps(db, member.tenantId));
  await ai.followUp;
  assert.equal(getRunDetail(db, ai.runId)!.status, "succeeded");
  // a team agent turns the issue into a PR on cobra/<run-id>
  createAgent(db, member, { name: "fixer", engine: "claude-code", prompt: "You fix bugs" });
  const pr = await createPrFromIssue(db, gh, member, REPO, i.number, { agent: "fixer", instructions: "Keep it small" }, deps(db, member.tenantId));
  await pr.followUp;
  const d = getRunDetail(db, pr.runId)!;
  assert.deepEqual([d.status, d.mode, d.workflow, d.repo], ["succeeded", "real", "agent:fixer", REPO]);
  assert.match(d.prompt!, /You fix bugs[\s\S]*Resolve GitHub issue #10[\s\S]*Broken button[\s\S]*Keep it small/);
  const prCall = calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!;
  assert.equal(prCall.body!.head, `cobra/${pr.runId}`);
  assert.equal(prCall.body!.base, "main");
  assert.match(String(prCall.body!.body), /^Closes #10/);
  const rows = listAudit(db, member.tenantId, REPO);
  assert.deepEqual(rows.map((r) => r.action).sort(), ["agent_issue", "comment", "issue_create", "pr_create", "pr_create"]);
  assert.ok(rows.every((r) => r.actorEmail === "member@a.com"));
  assert.equal(rows.find((r) => r.action === "agent_issue")!.runId, ai.runId);
  assert.deepEqual(listAudit(db, member.tenantId, REPO, i.number).map((r) => r.action).sort(), ["comment", "issue_create", "pr_create"], "issue page shows its PR");
  assert.deepEqual(listAudit(db, b.tenantId, REPO), [], "audit is per team");
  // no push => no PR (and no audit row)
  const before = calls.length;
  const p2 = await createPrFromIssue(db, gh, admin, REPO, i.number, { engine: "codex" }, deps(db, admin.tenantId, false));
  await p2.followUp;
  assert.equal(calls.slice(before).filter((c) => c.path.endsWith("/pulls")).length, 0);
  await assert.rejects(createPrFromIssue(db, gh, member, REPO, i.number, { agent: "nope" }, deps(db, member.tenantId)), status(404));
});
