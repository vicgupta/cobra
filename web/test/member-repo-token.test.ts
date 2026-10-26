// Members add their own repos with their own GitHub PAT; team-scoped; allow-list bypass for team repos with a PAT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addRepoWithToken, changeRepoToken, checkTeamRepo, listRepoAudit, listTeamRepos, removeTeamRepo, RepoError, teamPatSecrets, tokenFor, updateTeamRepo } from "../lib/repos";

const KEY = randomBytes(32).toString("base64");
const TOK = "ghp_" + "m".repeat(32) + "WXYZ", TOK2 = "ghp_" + "n".repeat(32) + "QRST";
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t };
  };
  return { db, m1: mk("m1@a.com", "member", "team-a"), m2: mk("m2@a.com", "member", "team-a"), lead: mk("lead@a.com", "team_lead", "team-a"),
    bm: mk("m@b.com", "member", "team-b"), bLead: mk("lead@b.com", "team_lead", "team-b") };
}
/** Fake GitHub: 200 for TOK/TOK2 with push access, 404 otherwise; records calls. */
function gh() {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const auth = String((init?.headers as Record<string, string>).Authorization);
    return auth === `Bearer ${TOK}` || auth === `Bearer ${TOK2}` ? new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 }) : new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const status = async (p: Promise<unknown>) => { try { await p; return 0; } catch (e) { assert.ok(e instanceof RepoError); return e.status; } };

test("a member adds a repo with their own PAT: validated, encrypted, last-4 only, team-shared, audited", async () => {
  const { db, m1, m2 } = setup(); const g = gh();
  const r = await addRepoWithToken(db, m1, { repo: "m1/own", pat: TOK }, KEY, g.f);
  assert.deepEqual([r.patSet, r.patLast4, r.pushAccess, r.createdBy], [true, "WXYZ", true, m1.id]);
  assert.equal(g.calls[0], "https://api.github.com/repos/m1/own");
  assert.ok(!JSON.stringify(r).includes(TOK) && !JSON.stringify(listTeamRepos(db, m2.tenantId)).includes(TOK));
  const enc = (db.prepare("SELECT pat_enc e FROM team_repos WHERE repo='m1/own'").get() as { e: string }).e;
  assert.ok(enc && !enc.includes(TOK));
  assert.equal(tokenFor(db, m2.tenantId, KEY, "server")("m1/own"), TOK, "team runs use the repo's token");
  assert.deepEqual(listRepoAudit(db, m1.tenantId).map((a) => [a.actorEmail, a.action]), [["m1@a.com", "token_set"], ["m1@a.com", "add"]]);
  assert.ok(!JSON.stringify(listRepoAudit(db, m1.tenantId)).includes(TOK));
});

test("member add: PAT required, bad token is a clear 400 and nothing is saved; leads may still omit it", async () => {
  const { db, m1, lead } = setup(); const g = gh();
  assert.equal(await status(addRepoWithToken(db, m1, { repo: "m1/own" }, KEY, g.f)), 400);
  await assert.rejects(addRepoWithToken(db, m1, { repo: "m1/own", pat: "ghp_" + "z".repeat(36) }, KEY, g.f), /can't access m1\/own on GitHub \(HTTP 404\); not saved/);
  assert.deepEqual(listTeamRepos(db, m1.tenantId), []);
  assert.equal(await status(addRepoWithToken(db, m1, { repo: "m1/own", pat: TOK }, undefined, g.f)), 503, "no server key: refuse, don't store plaintext");
  assert.deepEqual(listTeamRepos(db, m1.tenantId), []);
  assert.equal((await addRepoWithToken(db, lead, { repo: "acme/shared" }, KEY, g.f)).patSet, false);
});

test("token change/remove: adder, leads, admins; other members 403; audited", async () => {
  const { db, m1, m2, lead } = setup(); const g = gh();
  await addRepoWithToken(db, m1, { repo: "m1/own", pat: TOK }, KEY, g.f);
  assert.equal(await status(changeRepoToken(db, m2, "m1/own", TOK2, KEY, g.f)), 403);
  assert.equal((await changeRepoToken(db, m1, "m1/own", TOK2, KEY, g.f)).patLast4, "QRST");
  assert.equal((await changeRepoToken(db, lead, "m1/own", null, KEY, g.f)).patSet, false);
  assert.deepEqual(listRepoAudit(db, m1.tenantId).slice(0, 2).map((a) => [a.actorEmail, a.action]), [["lead@a.com", "token_clear"], ["m1@a.com", "token_set"]]);
});

test("cross-team isolation: list, token, check, edit, remove, token change are 404/invisible to other teams", async () => {
  const { db, m1, bm, bLead } = setup(); const g = gh();
  await addRepoWithToken(db, m1, { repo: "m1/own", pat: TOK }, KEY, g.f);
  const before = g.calls.length;
  assert.deepEqual(listTeamRepos(db, bm.tenantId), []);
  assert.match(checkTeamRepo(db, bm.tenantId, "m1/own")!, /not registered to this team/);
  assert.equal(tokenFor(db, bm.tenantId, KEY, undefined)("m1/own"), undefined);
  assert.deepEqual(teamPatSecrets(db, bm.tenantId, KEY), []);
  for (const u of [bm, bLead]) {
    assert.equal(await status(changeRepoToken(db, u, "m1/own", TOK2, KEY, g.f)), 404);
    assert.equal(await status(changeRepoToken(db, u, "m1/own", null, KEY, g.f)), 404);
    assert.equal(await status(Promise.resolve().then(() => updateTeamRepo(db, u, "m1/own", "dev"))), 404);
    assert.equal(await status(Promise.resolve().then(() => removeTeamRepo(db, u, "m1/own"))), 404);
  }
  assert.equal(g.calls.length, before, "another team's repo never reaches GitHub");
  // same repo name in team B is its own row with its own token
  await addRepoWithToken(db, bm, { repo: "m1/own", pat: TOK2 }, KEY, g.f);
  assert.equal(tokenFor(db, m1.tenantId, KEY, undefined)("m1/own"), TOK);
  assert.equal(tokenFor(db, bm.tenantId, KEY, undefined)("m1/own"), TOK2);
  assert.equal(listRepoAudit(db, bm.tenantId).every((a) => a.actorEmail === "m@b.com"), true);
});

test("allow-list: team repos with their own PAT bypass COBRA_GITHUB_ALLOWED_REPOS; without a PAT the ceiling still applies", async () => {
  const { db, m1, lead } = setup(); const g = gh();
  const prev = process.env.COBRA_GITHUB_ALLOWED_REPOS;
  process.env.COBRA_GITHUB_ALLOWED_REPOS = "acme/allowed";
  try {
    await addRepoWithToken(db, m1, { repo: "m1/own", pat: TOK }, KEY, g.f);
    await addRepoWithToken(db, lead, { repo: "acme/nopat" }, KEY, g.f);
    await addRepoWithToken(db, lead, { repo: "acme/allowed" }, KEY, g.f);
    assert.equal(checkTeamRepo(db, m1.tenantId, "m1/own"), null);
    assert.equal(checkTeamRepo(db, m1.tenantId, "acme/allowed"), null);
    assert.match(checkTeamRepo(db, m1.tenantId, "acme/nopat")!, /not in COBRA_GITHUB_ALLOWED_REPOS/);
    await changeRepoToken(db, m1, "m1/own", null, KEY, g.f);
    assert.match(checkTeamRepo(db, m1.tenantId, "m1/own")!, /not in COBRA_GITHUB_ALLOWED_REPOS/, "clearing the PAT re-applies the ceiling");
  } finally { if (prev === undefined) delete process.env.COBRA_GITHUB_ALLOWED_REPOS; else process.env.COBRA_GITHUB_ALLOWED_REPOS = prev; }
});
