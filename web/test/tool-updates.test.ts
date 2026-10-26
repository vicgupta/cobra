// Job 5: daily agent-tool updates with a mocked command runner and filesystem (no real installs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CollabError } from "../lib/collab";
import { buildDailyReport } from "../lib/notifications";
import * as U from "../lib/tool-updates";

const P = "/h/.local";
type World = { versions: Record<string, string>; latest: Record<string, string>; brokenAfterSwap?: string[]; stagedFails?: string[]; activeRuns?: number; cursorLatest?: string; calls: string[] };

/** A fake HOME: package dirs carry a version; bins resolve to their package dir. */
function mockOps(w: World): U.Ops {
  const dirs = new Map<string, string>(); // dir path -> version
  const links = new Map<string, string>();
  for (const t of U.NPM_TOOLS) { dirs.set(`${P}/lib/node_modules/${t.pkg}`, w.versions[t.tool]); links.set(`${P}/bin/${t.bin}`, `../lib/node_modules/${t.pkg}/bin/${t.bin}`); }
  const cv = `${P}/share/cursor-agent/versions/${w.versions.cursor}`; dirs.set(cv, w.versions.cursor);
  links.set(`${P}/bin/cursor-agent`, `${cv}/cursor-agent`); links.set(`${P}/bin/agent`, `${cv}/cursor-agent`);
  let tmp = 0; const files = new Map<string, string>();
  const resolveBin = (bin: string) => {
    const l = links.get(bin); if (!l) return null;
    const abs = l.startsWith("/") ? l : `${bin.slice(0, bin.lastIndexOf("/bin/"))}/bin/${l}`.replace(/\/bin\/\.\.\//, "/");
    return abs;
  };
  const pkgDirOf = (p: string) => [...dirs.keys()].find((d) => p.startsWith(d + "/"));
  return {
    env: { HOME: "/h", PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-secret-should-not-pass" },
    async run(cmd, args, o) {
      w.calls.push(`${cmd} ${args.join(" ")}`);
      assert.ok(!o?.env || !("OPENROUTER_API_KEY" in o.env), "secrets are not passed to tools");
      if (cmd === "npm" && args[0] === "view") { const t = U.NPM_TOOLS.find((x) => x.pkg === args[1])!; return { code: 0, out: `${w.latest[t.tool]}\n` }; }
      if (cmd === "npm" && args[0] === "i") {
        const stage = args[3], spec = args[4], pkg = spec.slice(0, spec.lastIndexOf("@")), v = spec.slice(spec.lastIndexOf("@") + 1);
        const t = U.NPM_TOOLS.find((x) => x.pkg === pkg)!;
        dirs.set(`${stage}/lib/node_modules/${pkg}`, v); links.set(`${stage}/bin/${t.bin}`, `../lib/node_modules/${pkg}/bin/${t.bin}`);
        return { code: 0, out: "added 1 package" };
      }
      if (cmd === "curl") { files.set(args[args.indexOf("-o") + 1], `#!/bin/bash\nDL=https://downloads.cursor.com/lab/${w.cursorLatest ?? w.versions.cursor}/linux/x64/agent.tar.gz\n`); return { code: 0, out: "" }; }
      if (cmd === "bash") { const nv = `${P}/share/cursor-agent/versions/${w.cursorLatest}`; dirs.set(nv, w.cursorLatest!); links.set(`${P}/bin/cursor-agent`, `${nv}/cursor-agent`); links.set(`${P}/bin/agent`, `${nv}/cursor-agent`); return { code: 0, out: "Happy coding" }; }
      if (args[0] === "--version") {
        const real = resolveBin(cmd); const d = real && pkgDirOf(real); const v = d ? dirs.get(d) : undefined;
        if (!v) return { code: 127, out: "not found" };
        const isStage = cmd.includes("/cobra-updates/");
        const tool = U.NPM_TOOLS.find((t) => d!.endsWith(t.pkg))?.tool ?? "cursor";
        if (isStage && w.stagedFails?.includes(tool)) return { code: 1, out: "Segmentation fault token=abc123" };
        if (!isStage && v !== w.versions[tool] && w.brokenAfterSwap?.includes(tool)) return { code: 1, out: "Error: GLIBC missing" };
        return { code: 0, out: `${v} (x)` };
      }
      if (args[0] === "models") return { code: 0, out: "opencode/big-pickle\nopencode/gpt-6-free\n" };
      return { code: 1, out: "unknown" };
    },
    exists: (p) => dirs.has(p) || files.has(p),
    readFile: (p) => { if (files.has(p)) return files.get(p)!; if (p.endsWith("models_cache.json")) return JSON.stringify({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6" }] }); const d = p.replace(/\/package\.json$/, ""); return dirs.has(d) ? JSON.stringify({ version: dirs.get(d) }) : null; },
    readlink: (p) => links.get(p) ?? null,
    realpath: (p) => resolveBin(p),
    rename: (a, b) => { if (!dirs.has(a)) throw new Error(`ENOENT ${a}`); dirs.set(b, dirs.get(a)!); dirs.delete(a); },
    rm: (p) => { for (const k of [...dirs.keys()]) if (k === p || k.startsWith(p + "/")) dirs.delete(k); files.delete(p); for (const k of [...files.keys()]) if (k.startsWith(p + "/")) files.delete(k); },
    mkdtemp: (prefix) => `${prefix}${++tmp}`,
    symlink: (target, link) => { links.set(link, target); },
  };
}

function setup(w: Partial<World> = {}) {
  const db = openDb(":memory:");
  const admin = createUser(db, { email: "root@a.com", tenant: "a", tenantName: "A", role: "admin", password: "pw-1234567890" });
  const member = createUser(db, { email: "m@a.com", tenant: "a", tenantName: "A", role: "member", password: "pw-1234567890" });
  const world: World = { versions: { "claude-code": "2.1.310", codex: "0.164.0", opencode: "1.19.4", cursor: "2026.10.22-27dcf5f" }, latest: { "claude-code": "2.1.320", codex: "0.164.0", opencode: "1.20.0" }, calls: [], ...w };
  return { db, world, ops: mockOps(world), admin: { id: admin, email: "root@a.com", role: "admin" }, member: { id: member, email: "m@a.com", role: "member" } };
}
const items = (db: ReturnType<typeof openDb>) => U.getUpdateRun(db)!.items;
const ny = (iso: string) => Date.parse(iso); // pass explicit offsets

test("scheduler: 4:00 AM ET (DST-correct), claimed once, same-day catch-up", async () => {
  const { db, ops } = setup();
  assert.equal(await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T03:59:00-04:00")), "not-due");
  assert.ok(["ok", "partial"].includes(await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T04:00:00-04:00"))));
  assert.equal(await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T04:01:00-04:00")), "already");
  // winter (EST, UTC-5): 09:00Z is 4:00 AM
  assert.equal(await U.maybeRunDailyUpdate(db, ops, ny("2026-12-01T08:59:00Z")), "not-due");
  assert.notEqual(await U.maybeRunDailyUpdate(db, ops, ny("2026-12-01T09:00:00Z")), "not-due");
  // catch-up: server down at 4, first tick at 9:15 AM
  const r = await U.maybeRunDailyUpdate(db, ops, ny("2026-12-02T09:15:00-05:00"));
  assert.ok(["ok", "partial"].includes(r));
  assert.match(U.listUpdateRuns(db)[0].reason ?? "", /catch-up/);
  assert.equal(U.nextScheduled(db, ny("2026-12-02T10:00:00-05:00")), ny("2026-12-03T04:00:00-05:00"));
});

test("npm tools: staged install, atomic swap, before/after recorded; unchanged when latest", async () => {
  const { db, ops, world } = setup();
  await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T04:00:00-04:00"));
  const it = Object.fromEntries(items(db).map((i) => [i.tool, i]));
  assert.deepEqual([it["claude-code"].before, it["claude-code"].after, it["claude-code"].result], ["2.1.310", "2.1.320", "changed"]);
  assert.deepEqual([it.codex.before, it.codex.after, it.codex.result], ["0.164.0", "0.164.0", "unchanged"]);
  assert.equal(it.opencode.result, "changed");
  assert.ok(world.calls.some((c) => /^npm i -g --prefix \/h\/\.local\/share\/cobra-updates\/claude-code-\d+ @anthropic-ai\/claude-code@2\.1\.320$/.test(c)), "installs into a staging prefix");
  assert.ok(!world.calls.some((c) => c.startsWith("npm i -g @")), "never installs straight into the live prefix");
  assert.equal(ops.exists(`${P}/lib/node_modules/@anthropic-ai/claude-code.cobra-prev`), true, "previous version kept");
  assert.equal(it["cursor"].result, "unchanged");
  assert.equal(it["openrouter-models"].result, "skipped");
  assert.match(it["openrouter-models"].detail ?? "", /ON HOLD/);
  assert.equal(it["opencode-zen"].after?.startsWith("2 models"), true);
});

test("rollback: new version fails --version after swap -> previous restored, marked rolled_back", async () => {
  const { db, ops } = setup({ brokenAfterSwap: ["claude-code"] });
  const s = await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T04:00:00-04:00"));
  assert.equal(s, "partial");
  const c = items(db).find((i) => i.tool === "claude-code")!;
  assert.equal(c.result, "rolled_back"); assert.equal(c.after, "2.1.310");
  assert.equal((await ops.run(`${P}/bin/claude`, ["--version"], {})).out.startsWith("2.1.310"), true, "live binary works again");
  assert.equal(ops.exists(`${P}/lib/node_modules/@anthropic-ai/claude-code.cobra-failed`), false);
});

test("staged smoke test fails -> live install untouched, failed, output redacted", async () => {
  const { db, ops } = setup({ stagedFails: ["opencode"] });
  await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T04:00:00-04:00"));
  const o = items(db).find((i) => i.tool === "opencode")!;
  assert.equal(o.result, "failed"); assert.equal(o.after, "1.19.4");
  assert.match(o.detail ?? "", /live install untouched/); assert.doesNotMatch(o.detail ?? "", /abc123/);
  assert.equal((await ops.run(`${P}/bin/opencode`, ["--version"], {})).out.startsWith("1.19.4"), true);
});

test("cursor: new version installed; failure repoints links to the previous version", async () => {
  const a = setup({ cursorLatest: "2026.10.29-aaaaaaa" });
  await U.maybeRunDailyUpdate(a.db, a.ops, ny("2026-10-27T04:00:00-04:00"));
  const c = items(a.db).find((i) => i.tool === "cursor")!;
  assert.deepEqual([c.before, c.after, c.result], ["2026.10.22-27dcf5f", "2026.10.29-aaaaaaa", "changed"]);
  const b = setup({ cursorLatest: "2026.10.29-aaaaaaa", brokenAfterSwap: ["cursor"] });
  await U.maybeRunDailyUpdate(b.db, b.ops, ny("2026-10-27T04:00:00-04:00"));
  const d = items(b.db).find((i) => i.tool === "cursor")!;
  assert.equal(d.result, "rolled_back");
  assert.equal(b.ops.readlink(`${P}/bin/cursor-agent`), `${P}/share/cursor-agent/versions/2026.10.22-27dcf5f/cursor-agent`);
  assert.equal(b.ops.readlink(`${P}/bin/agent`), `${P}/share/cursor-agent/versions/2026.10.22-27dcf5f/cursor-agent`);
});

test("active agent run: retry every 15 min until 6:30 AM ET, then skip and record", async () => {
  const { db, ops, world } = setup();
  db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, status, started_at) VALUES ('r1', 1, 'a', '', 0, 't', 'running', 1)").run();
  let t = ny("2026-10-27T04:00:00-04:00");
  assert.equal(await U.maybeRunDailyUpdate(db, ops, t), "waiting");
  assert.equal(await U.maybeRunDailyUpdate(db, ops, t + 5 * 60_000), "waiting"); // not yet 15 min
  let checks = 1;
  for (t += U.RETRY_MS; t < ny("2026-10-27T06:30:00-04:00"); t += U.RETRY_MS) { assert.equal(await U.maybeRunDailyUpdate(db, ops, t), "waiting"); checks++; }
  assert.equal(await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T06:30:00-04:00")), "skipped-busy");
  const r = U.listUpdateRuns(db)[0];
  assert.equal(r.status, "skipped"); assert.match(r.reason ?? "", /agent run in progress/);
  assert.equal(checks, 10);
  assert.equal(world.calls.length, 0, "nothing installed while a run was active");
  assert.match(buildDailyReport(db, ny("2026-10-27T07:00:00-04:00"), { uptimeSec: 1, diskFreeBytes: 1, diskTotalBytes: 1, dbBytes: 1 }).text, /AGENT TOOL UPDATES[\s\S]*skipped \(agent run in progress/);
});

test("admin: toggle (audited, default on), run now (admin only, refuses during agent runs), disabled skips", async () => {
  const { db, ops, admin, member } = setup();
  assert.equal(U.updateSettings(db).enabled, true);
  assert.throws(() => U.setUpdatesEnabled(db, member, false), (e) => e instanceof CollabError && e.status === 403);
  assert.throws(() => U.startManualRun(db, member, ops), (e) => e instanceof CollabError && e.status === 403);
  U.setUpdatesEnabled(db, admin, false);
  assert.equal(await U.maybeRunDailyUpdate(db, ops, ny("2026-10-27T04:00:00-04:00")), "disabled");
  db.prepare("INSERT INTO runs (id, tenant_id, agent, repo, issue, title, status, started_at) VALUES ('r1', 1, 'a', '', 0, 't', 'running', 1)").run();
  assert.throws(() => U.startManualRun(db, admin, ops), (e) => e instanceof CollabError && e.status === 409);
  db.prepare("UPDATE runs SET status = 'succeeded'").run();
  const id = U.startManualRun(db, admin, ops);
  for (let i = 0; i < 50 && U.updating(); i++) await new Promise((r) => setImmediate(r));
  const v = U.getUpdateRun(db, id)!;
  assert.equal(v.kind, "manual"); assert.ok(v.items.length >= 8);
  const acts = (db.prepare("SELECT action FROM notification_audit ORDER BY id").all() as { action: string }[]).map((a) => a.action);
  assert.deepEqual(acts, ["updates_toggle", "updates_run_now"]);
});
