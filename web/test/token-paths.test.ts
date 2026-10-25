// Job 20: one per-repo token resolver for every path an agent run touches GitHub.
// The repo's PAT when set, else GITHUB_TOKEN; never both; none when a set PAT can't be decrypted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { addTeamRepo, checkTeamRepo, setRepoPat, tokenFor } from "../lib/repos";
import { githubApi } from "../lib/github-api";
import { localRunner } from "../lib/workflows/local-runner";
import { builtinHandlers } from "../lib/workflows/handlers";
import { createPrFromIssue, agentIssue } from "../lib/collab";
import type { Actor } from "../lib/workflows/store";
import type { RunDeps } from "../lib/workflows/service";

const KEY = randomBytes(32).toString("base64");
const PAT = "ghp_REPOpatREPOpat0123456789abcd";
const SERVER = "server-GITHUB_TOKEN-value-123";

function setup() {
  const db = openDb(":memory:");
  const id = createUser(db, { email: "lead@a.com", tenant: "team-a", tenantName: "team-a", role: "team_lead", password: "pw-1234567890" });
  const tenantId = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
  const u = { id, email: "lead@a.com", role: "team_lead", tenantId } as Actor;
  addTeamRepo(db, u, "owner/withpat", "main");
  addTeamRepo(db, u, "owner/nopat", "main");
  setRepoPat(db, u, "owner/withpat", PAT, KEY);
  return { db, u, resolve: tokenFor(db, tenantId, KEY, SERVER) };
}

/** GitHub fake that records which token each call used (by label, never the value). */
function recordingFetch() {
  const used: string[] = [];
  const label = (h: string) => (h === `Bearer ${PAT}` ? "pat" : h === `Bearer ${SERVER}` ? "server" : "other");
  const f = (async (url: string, init: RequestInit) => {
    const p = url.replace("https://api.github.com", ""), method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    used.push(`${method} ${p.split("/").slice(2, 4).join("/")} ${label(String((init.headers as Record<string, string>).Authorization ?? (init.headers as Record<string, string>).authorization))}`);
    const j = (v: unknown, s = 200) => new Response(JSON.stringify(v), { status: s });
    if (method === "GET" && /\/issues\/\d+$/.test(p)) return j({ number: 5, title: "Bug", body: "fix", state: "open", html_url: "", user: null, created_at: "", comments: 0 });
    if (method === "POST" && /\/issues$/.test(p)) return j({ number: 6, title: body.title, html_url: "" }, 201);
    if (method === "POST" && /\/pulls$/.test(p)) return j({ number: 7, title: body.title, html_url: "", head: { ref: body.head, sha: "s" }, base: { ref: body.base } }, 201);
    return j({ default_branch: "main" });
  }) as unknown as typeof fetch;
  return { f, used };
}

test("resolver: PAT for its repo (any case), GITHUB_TOKEN otherwise, nothing when a set PAT can't be decrypted", () => {
  const { db, u, resolve } = setup();
  assert.equal(resolve("owner/withpat"), PAT);
  assert.equal(resolve("Owner/WithPat"), PAT);
  assert.equal(resolve("owner/nopat"), SERVER);
  assert.equal(tokenFor(db, u.tenantId, randomBytes(32).toString("hex"), SERVER)("owner/withpat"), undefined);
  assert.equal(tokenFor(db, u.tenantId + 1, KEY, SERVER)("owner/withpat"), SERVER, "another tenant's PAT is never used");
});

test("agent subprocess env: GH_TOKEN/GITHUB_TOKEN are the repo's PAT (or GITHUB_TOKEN), one value, none without a repo", async () => {
  const { resolve, db, u } = setup();
  const tmp = mkdtempSync(path.join(tmpdir(), "cobra-tok-"));
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
  const seed = path.join(tmp, "seed"); execFileSync("mkdir", ["-p", seed, path.join(tmp, "remote/owner")]);
  git(seed, "init", "-q", "-b", "main"); writeFileSync(path.join(seed, "R.md"), "r\n");
  git(seed, "add", "."); git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  for (const r of ["withpat", "nopat"]) git(tmp, "clone", "-q", "--bare", seed, path.join(tmp, `remote/owner/${r}.git`));
  // The fake CLI records which token it got (compared in the test, never logged).
  const fake = path.join(tmp, "fake");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "\${GH_TOKEN-unset}" "\${GITHUB_TOKEN-unset}" "$2" > .git/seen\necho done\n`); chmodSync(fake, 0o755);
  const mk = (resolver?: (r: string) => string | undefined) => localRunner({ root: path.join(tmp, "ws"), resolveSecret: (n) => (n === "GITHUB_TOKEN" ? SERVER : undefined), githubToken: resolver,
    checkRepo: (r) => checkTeamRepo(db, u.tenantId, r), defaultBranch: () => "main", claudeBin: fake, codexBin: fake, remoteBase: `file://${tmp}/remote` });
  const seen = (id: string) => readFileSync(path.join(tmp, "ws", id, ".git/seen"), "utf8").split("\n");
  const logs: string[] = [];
  const go = (id: string, w: Record<string, unknown>, r = mk(resolve), driver: "claude-code" | "codex" = "claude-code") => r({ runId: id, driver, with: w, secrets: {}, signal: new AbortController().signal, log: (c) => logs.push(c) });

  await go("r1", { repo: "owner/withpat", prompt: "make an issue" });
  assert.deepEqual(seen("r1").slice(0, 2), [PAT, PAT], "claude: repo PAT in both vars");
  assert.match(seen("r1").slice(2).join("\n"), /\$GH_TOKEN/, "prompt tells the agent where the token is");
  await go("r2", { repo: "owner/withpat", prompt: "x" }, mk(resolve), "codex");
  assert.ok(readFileSync(path.join(tmp, "ws/r2/.git/seen"), "utf8").startsWith(`${PAT}\n${PAT}\n`), "codex: repo PAT");
  await go("r3", { repo: "owner/nopat", prompt: "x" });
  assert.deepEqual(seen("r3").slice(0, 2), [SERVER, SERVER], "no PAT: GITHUB_TOKEN");
  await go("r4", { prompt: "x" });
  assert.deepEqual(seen("r4").slice(0, 2), ["unset", "unset"], "no repo: no token at all");
  await go("r5", { repo: "owner/withpat", prompt: "x" }, mk(tokenFor(db, u.tenantId, randomBytes(32).toString("hex"), SERVER)));
  assert.deepEqual(seen("r5").slice(0, 2), ["unset", "unset"], "undecryptable PAT: no silent GITHUB_TOKEN");
  const all = logs.join("");
  assert.ok(!all.includes(PAT) && !all.includes(SERVER), "tokens never in the logs");
});

test("collab: Create PR and the issue agent use the per-repo resolver for every GitHub call", async () => {
  const { db, u, resolve } = setup();
  const { f, used } = recordingFetch();
  const gh = githubApi(resolve, f);
  const deps: RunDeps = { handlers: builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, u.tenantId, r), agentRunner: async ({ runId, driver }) => ({ driver, branch: `cobra/${runId}`, pushed: true, summary: "Title\nbody" }) }), resolveSecret: () => undefined, redact: () => [] };
  for (const repo of ["owner/withpat", "owner/nopat"]) {
    await (await createPrFromIssue(db, gh, u, repo, 5, { engine: "claude-code" }, deps)).followUp;
    await agentIssue(db, gh, u, repo, { prompt: "p", engine: "codex", mode: "simulated" }, deps).followUp;
  }
  assert.deepEqual(used, [
    "GET owner/withpat pat", "POST owner/withpat pat", "POST owner/withpat pat",
    "GET owner/nopat server", "POST owner/nopat server", "POST owner/nopat server",
  ]);
});

test("workflow github steps use the same resolver: PAT, else the step's GITHUB_TOKEN", async () => {
  const { db, u, resolve } = setup();
  const { f, used } = recordingFetch();
  const h = builtinHandlers({ fetch: f, checkRepo: (r) => checkTeamRepo(db, u.tenantId, r), tokenFor: resolve }).github;
  for (const repo of ["owner/withpat", "owner/nopat"])
    await h!({ runId: "r", step: {} as never, with: { repo, action: "create-issue", title: "t" }, secrets: { GITHUB_TOKEN: SERVER }, signal: new AbortController().signal } as never);
  assert.deepEqual(used, ["POST owner/withpat pat", "POST owner/nopat server"]);
});
