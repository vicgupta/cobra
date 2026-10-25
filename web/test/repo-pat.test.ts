// Job 19: per-repo GitHub PATs (encrypted, masked, used instead of GITHUB_TOKEN when set).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, listTeamRepos, RepoError, repoPat, setRepoPat, teamPatSecrets, tokenFor, verifyPat } from "../lib/repos";
import { decryptSecret, encryptSecret, SecretKeyError } from "../lib/secret-box";
import { githubApi } from "../lib/github-api";
import { githubFiles } from "../lib/workflows/github-files";
import { github } from "../lib/workflows/handlers";
import { redact } from "../lib/workflows/engine";

const KEY = randomBytes(32).toString("base64");
const PAT = "ghp_FAKEfakeFAKEfake0123456789abcd";
const SERVER = "server-github-token-xyz";

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member") => {
    const id = createUser(db, { email, tenant: "team-a", tenantName: "team-a", role, password: "pw-1234567890" });
    return { id, role, tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t };
  };
  const lead = mk("lead@a.com", "team_lead"), member = mk("m@a.com", "member");
  addTeamRepo(db, lead, "acme/with-pat");
  addTeamRepo(db, lead, "acme/no-pat");
  return { db, lead, member };
}
const is = (status: number) => (e: unknown) => e instanceof RepoError && e.status === status;

test("secret box: AES-256-GCM round trip, wrong key and missing key fail", () => {
  const enc = encryptSecret(PAT, KEY);
  assert.ok(!enc.includes(PAT));
  assert.notEqual(encryptSecret(PAT, KEY), enc, "random IV");
  assert.equal(decryptSecret(enc, KEY), PAT);
  assert.throws(() => decryptSecret(enc, randomBytes(32).toString("base64")));
  assert.throws(() => encryptSecret(PAT, undefined), (e) => e instanceof SecretKeyError && /COBRA_SECRET_KEY is not set/.test(e.message));
  assert.throws(() => encryptSecret(PAT, "short"), SecretKeyError);
});

test("repo PAT: stored encrypted, list/API shape never has the token, legacy rows are unset", () => {
  const { db, lead } = setup();
  assert.deepEqual(listTeamRepos(db, lead.tenantId).map((r) => [r.repo, r.patSet, r.patLast4]), [["acme/no-pat", false, null], ["acme/with-pat", false, null]]);
  const r = setRepoPat(db, lead, "acme/with-pat", `  ${PAT}  `, KEY);
  assert.deepEqual([r.patSet, r.patLast4], [true, "abcd"]);
  const row = db.prepare("SELECT pat_enc, pat_last4, pat_set_at FROM team_repos WHERE repo = 'acme/with-pat'").get() as Record<string, unknown>;
  assert.ok(!String(row.pat_enc).includes(PAT) && typeof row.pat_set_at === "number");
  const json = JSON.stringify(listTeamRepos(db, lead.tenantId));
  assert.ok(!json.includes(PAT) && !json.includes(String(row.pat_enc)), "list never carries the token or ciphertext");
  for (const x of listTeamRepos(db, lead.tenantId)) assert.deepEqual(Object.keys(x).sort(), ["createdAt", "defaultBranch", "patLast4", "patSet", "repo"]);
  assert.equal(repoPat(db, lead.tenantId, "ACME/with-pat", KEY), PAT);
  setRepoPat(db, lead, "acme/with-pat", null, KEY);
  assert.equal(listTeamRepos(db, lead.tenantId).find((x) => x.repo === "acme/with-pat")!.patSet, false);
});

test("repo PAT: members can't set or clear; missing key and malformed tokens are clear errors", () => {
  const { db, lead, member } = setup();
  assert.throws(() => setRepoPat(db, member, "acme/with-pat", PAT, KEY), is(403));
  assert.throws(() => setRepoPat(db, member, "acme/with-pat", null, KEY), is(403));
  assert.throws(() => setRepoPat(db, lead, "acme/with-pat", PAT, undefined), (e) => e instanceof RepoError && e.status === 503 && /COBRA_SECRET_KEY/.test(e.message));
  assert.throws(() => setRepoPat(db, lead, "acme/with-pat", "has space in it 1234567890", KEY), is(400));
  assert.throws(() => setRepoPat(db, lead, "other/repo", PAT, KEY), is(404));
});

test("repo PAT: GitHub calls use the repo's PAT, else fall back to GITHUB_TOKEN", async () => {
  const { db, lead } = setup();
  setRepoPat(db, lead, "acme/with-pat", PAT, KEY);
  const seen: Array<[string, string]> = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    seen.push([String(url).replace("https://api.github.com/repos/", "").split("/").slice(0, 2).join("/"), (h.Authorization ?? h.authorization).replace("Bearer ", "")]);
    return new Response(JSON.stringify({ number: 1, html_url: "u", content: "", sha: "s" }), { status: 200 });
  }) as typeof fetch;
  const tok = (repo: string) => tokenFor(db, lead.tenantId, KEY, SERVER)(repo);
  await githubApi(tok, fake).getIssue("acme/with-pat", 1);
  await githubApi(tok, fake).getIssue("acme/no-pat", 1);
  await githubFiles(tok, fake).get("acme/with-pat", "w.yaml");
  await githubFiles(tok, fake).get("acme/no-pat", "w.yaml");
  const h = github(fake, () => null, (r) => tokenFor(db, lead.tenantId, KEY, undefined)(r));
  const step = (repo: string) => h({ runId: "r", step: {} as never, with: { repo, action: "create-issue", title: "t" }, secrets: { GITHUB_TOKEN: SERVER }, signal: new AbortController().signal } as never);
  await step("acme/with-pat"); await step("acme/no-pat");
  assert.deepEqual(seen, [["acme/with-pat", PAT], ["acme/no-pat", SERVER], ["acme/with-pat", PAT], ["acme/no-pat", SERVER], ["acme/with-pat", PAT], ["acme/no-pat", SERVER]]);
  // Undecryptable (wrong key) also falls back instead of leaking or crashing.
  assert.equal(tokenFor(db, lead.tenantId, randomBytes(32).toString("base64"), SERVER)("acme/with-pat"), SERVER);
});

test("repo PAT: redaction covers the token and its git auth-header form", () => {
  const { db, lead } = setup();
  setRepoPat(db, lead, "acme/with-pat", PAT, KEY);
  const secrets = teamPatSecrets(db, lead.tenantId, KEY);
  const header = Buffer.from(`x-access-token:${PAT}`).toString("base64");
  const out = redact(`fatal: https://x-access-token:${PAT}@github.com/acme/with-pat.git\nAUTHORIZATION: basic ${header}\nerror {"t":"${PAT}"}`, secrets);
  assert.ok(!out.includes(PAT) && !out.includes(header));
  assert.equal(out.split("[REDACTED]").length - 1, 3);
});

test("repo PAT: verifyPat rejects tokens GitHub refuses and reports push access", async () => {
  const resp = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  await assert.rejects(verifyPat("acme/x", PAT, resp(401)), is(400));
  await assert.rejects(verifyPat("acme/x", PAT, resp(404)), is(400));
  assert.deepEqual(await verifyPat("acme/x", PAT, resp(200, { permissions: { push: true } })), { push: true });
  assert.deepEqual(await verifyPat("acme/x", PAT, resp(200, { permissions: { push: false } })), { push: false });
  assert.deepEqual(await verifyPat("acme/x", PAT, (async () => { throw new Error("offline"); }) as unknown as typeof fetch), { push: null });
});
