// Daily agent-tool updates (Job 5): at 4:00 AM America/New_York the server updates the agent CLIs it runs
// (Claude Code, Codex, OpenCode via npm; Cursor CLI via its installer) and refreshes the model catalogs
// it can read, recording each as a Before/After snapshot (update_runs + update_items), shown in
// Settings > Updates and summarized in the 7 AM admin email.
//
// Never-broken guarantee for CLIs:
//  - npm tools install into a staging prefix first; the staged binary must pass `--version` before the
//    live package dir is swapped with two same-filesystem renames (old dir kept as <pkg>.cobra-prev).
//    The live binary is smoke-tested again; on failure the renames are reversed (rolled_back).
//  - Cursor CLI: the installer adds a new versions/<v> dir and repoints the links; the previous target
//    is recorded and the links are atomically repointed back if the new one fails `--version`.
// Commands run with a minimal env (HOME, PATH, USER, LANG): no API keys or tokens, except the one key a
// catalog listing needs (OPENCODE_API_KEY / CURSOR_API_KEY), and output is redacted before storage.
// Auth files are never read or written by Cobra; the only file read under ~/.codex is models_cache.json.
// Pure Node, all side effects injected (Ops) so tests use mocks. OpenRouter is ON HOLD: not refreshed.
import path from "node:path";
import type { DB } from "./db";
import { CollabError, isSystemAdmin } from "./collab";
import { fmtNy, nyClock } from "./notifications";

export const UPDATE_HOUR = 4;
export const WAIT_UNTIL_MIN = 6 * 60 + 30; // 6:30 AM ET: stop waiting for an active agent run
export const RETRY_MS = 15 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;

export type RunResult = { code: number; out: string };
export type Ops = {
  run(cmd: string, args: string[], o?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string }): Promise<RunResult>;
  exists(p: string): boolean;
  readFile(p: string): string | null;
  readlink(p: string): string | null; // raw link text, or null if not a symlink
  realpath(p: string): string | null;
  rename(a: string, b: string): void;
  rm(p: string): void;
  mkdtemp(prefix: string): string;
  /** Atomically point `link` at `target` (write link.tmp, rename over). */
  symlink(target: string, link: string): void;
  env: Record<string, string | undefined>;
};

type Admin = { id: number; email: string; role: string };
export type Item = { tool: string; label: string; kind: "cli" | "catalog"; before: string | null; after: string | null; result: "changed" | "unchanged" | "rolled_back" | "failed" | "skipped"; method: string; detail: string };

export const NPM_TOOLS = [
  { tool: "claude-code", label: "Claude Code CLI", bin: "claude", pkg: "@anthropic-ai/claude-code" },
  { tool: "codex", label: "Codex CLI", bin: "codex", pkg: "@openai/codex" },
  { tool: "opencode", label: "OpenCode CLI", bin: "opencode", pkg: "opencode-ai" },
] as const;

const REDACT = /(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+|(?:api[_-]?key|token|secret|password|authorization)["'\s:=]+\S+)/gi;
export const redact = (s: string) => s.replace(REDACT, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
const firstVersion = (s: string) => (s.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/) ?? [null])[0];

function baseEnv(ops: Ops): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR"]) if (ops.env[k]) e[k] = ops.env[k]!;
  e.npm_config_update_notifier = "false"; e.npm_config_fund = "false"; e.npm_config_audit = "false";
  e.CI = "1"; e.NO_COLOR = "1";
  return e;
}
const prefixOf = (ops: Ops) => ops.env.COBRA_TOOLS_PREFIX || path.join(ops.env.HOME || "/home/cobra", ".local");

async function versionOf(ops: Ops, bin: string): Promise<{ ok: boolean; v: string | null; out: string }> {
  const r = await ops.run(bin, ["--version"], { env: baseEnv(ops), timeoutMs: 60_000 });
  return { ok: r.code === 0 && !!firstVersion(r.out), v: firstVersion(r.out) ?? (r.out.trim().split("\n")[0]?.slice(0, 60) || null), out: r.out };
}

// ---------- npm-managed CLIs ----------
export async function updateNpmTool(ops: Ops, t: (typeof NPM_TOOLS)[number]): Promise<Item> {
  const prefix = prefixOf(ops), env = baseEnv(ops);
  const pkgDir = path.join(prefix, "lib", "node_modules", t.pkg), link = path.join(prefix, "bin", t.bin);
  const base = { tool: t.tool, label: t.label, kind: "cli" as const };
  const before = await versionOf(ops, link);
  const real = ops.realpath(link);
  if (!real || !real.startsWith(pkgDir + path.sep)) {
    return { ...base, before: before.v, after: before.v, result: before.ok ? "skipped" : "failed", method: "not npm-managed", detail: real ? `${link} resolves outside ${pkgDir}; not updated` : `${link} not found` };
  }
  const installed = (() => { try { return JSON.parse(ops.readFile(path.join(pkgDir, "package.json")) ?? "{}").version as string | undefined; } catch { return undefined; } })() ?? before.v;
  const method = `npm i -g ${t.pkg}@latest (staged, atomic swap)`;
  const view = await ops.run("npm", ["view", t.pkg, "version"], { env, timeoutMs: 120_000 });
  const latest = view.code === 0 ? firstVersion(view.out) : null;
  if (!latest) return { ...base, before: installed ?? null, after: installed ?? null, result: "failed", method, detail: `npm view failed: ${redact(view.out)}` };
  if (latest === installed) {
    return before.ok ? { ...base, before: installed, after: installed, result: "unchanged", method, detail: "already latest; --version ok" }
      : { ...base, before: installed, after: installed, result: "failed", method, detail: `already latest but --version fails: ${redact(before.out)}` };
  }
  const stageRoot = ops.mkdtemp(path.join(prefix, "share", "cobra-updates", `${t.tool}-`));
  const cleanup = () => { try { ops.rm(stageRoot); } catch { /* best effort */ } };
  const inst = await ops.run("npm", ["i", "-g", "--prefix", stageRoot, `${t.pkg}@${latest}`], { env, timeoutMs: 15 * 60_000 });
  const stagedPkg = path.join(stageRoot, "lib", "node_modules", t.pkg), stagedLink = path.join(stageRoot, "bin", t.bin);
  if (inst.code !== 0 || !ops.exists(stagedPkg)) { cleanup(); return { ...base, before: installed, after: installed, result: "failed", method, detail: `staged install failed (live install untouched): ${redact(inst.out)}` }; }
  const staged = await versionOf(ops, stagedLink);
  if (!staged.ok || staged.v !== latest) { cleanup(); return { ...base, before: installed, after: installed, result: "failed", method, detail: `staged ${latest} failed --version (live install untouched): ${redact(staged.out)}` }; }
  // Swap: live -> .cobra-prev, staged -> live; repoint the bin link to the staged package's relative target.
  const prev = `${pkgDir}.cobra-prev`, oldLink = ops.readlink(link), newLinkRel = ops.readlink(stagedLink);
  if (ops.exists(prev)) ops.rm(prev);
  ops.rename(pkgDir, prev);
  try { ops.rename(stagedPkg, pkgDir); } catch (e) { ops.rename(prev, pkgDir); cleanup(); return { ...base, before: installed, after: installed, result: "failed", method, detail: `swap failed, restored: ${redact(String(e))}` }; }
  if (newLinkRel && newLinkRel !== oldLink) ops.symlink(newLinkRel, link);
  cleanup();
  const after = await versionOf(ops, link);
  if (after.ok && after.v === latest) return { ...base, before: installed, after: latest, result: "changed", method, detail: `previous kept at ${path.basename(prev)}; --version ok` };
  // Roll back: reverse the renames and the link, then re-verify.
  const failedDir = `${pkgDir}.cobra-failed`;
  if (ops.exists(failedDir)) ops.rm(failedDir);
  ops.rename(pkgDir, failedDir); ops.rename(prev, pkgDir);
  if (oldLink && newLinkRel !== oldLink) ops.symlink(oldLink, link);
  ops.rm(failedDir);
  const back = await versionOf(ops, link);
  return { ...base, before: installed, after: back.v, result: "rolled_back", method, detail: `${latest} failed --version (${redact(after.out)}); rolled back to ${back.v}${back.ok ? "" : " (STILL FAILING)"}` };
}

// ---------- Cursor CLI (installer + versions dir) ----------
export async function updateCursor(ops: Ops): Promise<Item> {
  const prefix = prefixOf(ops), env = baseEnv(ops);
  const links = ["cursor-agent", "agent"].map((b) => path.join(prefix, "bin", b));
  const versionsDir = path.join(prefix, "share", "cursor-agent", "versions");
  const base = { tool: "cursor", label: "Cursor agent CLI", kind: "cli" as const, method: "cursor.com/install (new versions/<v> dir, links repointed)" };
  const prevTarget = ops.readlink(links[0]);
  if (!prevTarget) return { ...base, before: null, after: null, result: "skipped", detail: "cursor-agent not installed" };
  if (!prevTarget.startsWith(versionsDir + path.sep)) return { ...base, before: null, after: null, result: "skipped", method: "not installer-managed", detail: `link points outside ${versionsDir}` };
  const cur = path.basename(path.dirname(prevTarget));
  const before = await versionOf(ops, links[0]);
  const script = path.join(ops.mkdtemp(path.join(prefix, "share", "cobra-updates", "cursor-")), "install.sh");
  const cleanup = () => { try { ops.rm(path.dirname(script)); } catch { /* best effort */ } };
  const dl = await ops.run("curl", ["-fsSL", "--max-time", "120", "-o", script, "https://cursor.com/install"], { env, timeoutMs: 150_000 });
  const latest = dl.code === 0 ? ((ops.readFile(script) ?? "").match(/\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{6,})\b/) ?? [null])[1] : null;
  if (!latest) { cleanup(); return { ...base, before: cur, after: cur, result: "failed", detail: dl.code !== 0 ? `installer download failed: ${redact(dl.out)}` : "could not read the version from the installer" }; }
  if (latest === cur) { cleanup(); return before.ok ? { ...base, before: cur, after: cur, result: "unchanged", detail: "already latest; --version ok" } : { ...base, before: cur, after: cur, result: "failed", detail: `already latest but --version fails: ${redact(before.out)}` }; }
  const inst = await ops.run("bash", [script], { env, timeoutMs: 15 * 60_000 });
  cleanup();
  const after = await versionOf(ops, links[0]);
  const nowTarget = ops.readlink(links[0]);
  if (inst.code === 0 && after.ok && nowTarget && nowTarget !== prevTarget) return { ...base, before: cur, after: path.basename(path.dirname(nowTarget)), result: "changed", detail: `previous kept in versions/${cur}; --version ok` };
  for (const l of links) if (ops.readlink(l) !== null || l === links[0]) ops.symlink(prevTarget, l);
  const back = await versionOf(ops, links[0]);
  return { ...base, before: cur, after: cur, result: "rolled_back", detail: `${latest} ${inst.code !== 0 ? `installer failed (${redact(inst.out)})` : `failed --version (${redact(after.out)})`}; links repointed to versions/${cur}${back.ok ? "" : " (STILL FAILING)"}` };
}

// ---------- model catalogs (read-only snapshots) ----------
function fingerprint(ids: string[]) {
  let h = 0; for (const c of ids.join("\n")) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return `${ids.length} models #${(h >>> 0).toString(16).padStart(8, "0").slice(0, 8)}`;
}
function catalogItem(tool: string, label: string, method: string, before: { state: string | null; ids: string[] | null }, ids: string[] | null, err: string | null): Item & { ids?: string[] } {
  if (!ids) return { tool, label, kind: "catalog", before: before.state, after: before.state, result: "failed", method, detail: err ?? "unavailable" };
  const st = fingerprint(ids);
  const prevIds = before.ids ?? [];
  const added = ids.filter((x) => !prevIds.includes(x)), removed = prevIds.filter((x) => !ids.includes(x));
  const changed = before.state !== null && st !== before.state;
  const detail = before.state === null ? "first snapshot" : changed ? `+${added.length} ${added.slice(0, 6).join(", ")}${added.length > 6 ? "…" : ""}; -${removed.length} ${removed.slice(0, 6).join(", ")}${removed.length > 6 ? "…" : ""}` : "no change";
  return { tool, label, kind: "catalog", before: before.state, after: st, result: changed ? "changed" : "unchanged", method, detail, ids };
}

export async function catalogs(ops: Ops, prev: (tool: string) => { state: string | null; ids: string[] | null }): Promise<Array<Item & { ids?: string[] }>> {
  const prefix = prefixOf(ops), env = baseEnv(ops), out: Array<Item & { ids?: string[] }> = [];
  // OpenCode Zen (opencode/<model>): the CLI's own refreshed listing; paid ids only appear with the key.
  {
    const e = { ...env, ...(ops.env.OPENCODE_API_KEY ? { OPENCODE_API_KEY: ops.env.OPENCODE_API_KEY } : {}) };
    let r = await ops.run(path.join(prefix, "bin", "opencode"), ["models", "opencode", "--refresh"], { env: e, timeoutMs: 120_000 });
    if (r.code !== 0) r = await ops.run(path.join(prefix, "bin", "opencode"), ["models", "opencode"], { env: e, timeoutMs: 120_000 });
    const ids = r.code === 0 ? [...new Set(r.out.split("\n").map((l) => l.trim()).filter((l) => /^opencode\/[\w.:-]+$/.test(l)))].sort() : null;
    out.push(catalogItem("opencode-zen", "OpenCode Zen models", `opencode models opencode --refresh${ops.env.OPENCODE_API_KEY ? " (with OPENCODE_API_KEY)" : " (free models only: no key)"}`, prev("opencode-zen"), ids?.length ? ids : null, `listing failed: ${redact(r.out)}`));
  }
  // Codex: the CLI maintains ~/.codex/models_cache.json itself; read-only.
  {
    const raw = ops.readFile(path.join(ops.env.HOME || "/home/cobra", ".codex", "models_cache.json"));
    let ids: string[] | null = null;
    try {
      const j = raw ? JSON.parse(raw) : null;
      const arr: unknown[] = Array.isArray(j) ? j : Array.isArray(j?.models) ? j.models : [];
      ids = [...new Set(arr.map((m) => (typeof m === "string" ? m : (m as { slug?: string; id?: string })?.slug ?? (m as { id?: string })?.id)).filter((x): x is string => typeof x === "string"))].sort();
    } catch { ids = null; }
    out.push(catalogItem("codex-models", "Codex models", "~/.codex/models_cache.json (refreshed by the Codex CLI)", prev("codex-models"), ids?.length ? ids : null, raw ? "cache unreadable" : "no models_cache.json yet"));
  }
  // Cursor: `cursor-agent models` needs CURSOR_API_KEY.
  if (!ops.env.CURSOR_API_KEY) out.push({ tool: "cursor-models", label: "Cursor models", kind: "catalog", before: prev("cursor-models").state, after: prev("cursor-models").state, result: "skipped", method: "cursor-agent models", detail: "needs CURSOR_API_KEY (not set)" });
  else {
    const r = await ops.run(path.join(prefix, "bin", "cursor-agent"), ["models"], { env: { ...env, CURSOR_API_KEY: ops.env.CURSOR_API_KEY }, timeoutMs: 120_000 });
    const ids = r.code === 0 ? [...new Set(r.out.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((l) => /^[\w.-]+$/.test(l ?? "")))].sort() : null;
    out.push(catalogItem("cursor-models", "Cursor models", "cursor-agent models", prev("cursor-models"), ids?.length ? ids : null, `listing failed: ${redact(r.out)}`));
  }
  out.push({ tool: "openrouter-models", label: "OpenRouter models", kind: "catalog", before: null, after: null, result: "skipped", method: "—", detail: "ON HOLD: refreshing would require changing lib/openrouter.ts" });
  return out;
}

// ---------- runs ----------
export const activeAgentRuns = (db: DB) => (db.prepare("SELECT count(*) n FROM runs WHERE status IN ('running','pending','queued')").get() as { n: number }).n;

function prevCatalog(db: DB, tool: string) {
  const r = db.prepare("SELECT after, detail FROM update_items WHERE tool = ? AND after IS NOT NULL ORDER BY id DESC LIMIT 1").get(tool) as { after: string; detail: string } | undefined;
  const ids = (db.prepare("SELECT ids FROM update_catalog_ids WHERE tool = ?").get(tool) as { ids: string } | undefined)?.ids;
  return { state: r?.after ?? null, ids: ids ? (JSON.parse(ids) as string[]) : null };
}

const g = globalThis as { __cobraUpdating?: boolean };
export const updating = () => !!g.__cobraUpdating;

/** Runs every tool for an update_runs row (status already 'running'). Never throws. */
export async function executeRun(db: DB, runId: number, ops: Ops, now: () => number = Date.now): Promise<string> {
  g.__cobraUpdating = true;
  const ins = db.prepare("INSERT INTO update_items (run_id, tool, label, kind, before, after, result, method, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const save = (i: Item) => ins.run(runId, i.tool, i.label, i.kind, i.before, i.after, i.result, i.method, i.detail, now());
  const results: string[] = [];
  try {
    for (const t of NPM_TOOLS) {
      const i = await updateNpmTool(ops, t).catch((e: unknown) => ({ tool: t.tool, label: t.label, kind: "cli" as const, before: null, after: null, result: "failed" as const, method: "npm", detail: redact(String(e)) }));
      save(i); results.push(i.result);
    }
    const c = await updateCursor(ops).catch((e: unknown) => ({ tool: "cursor", label: "Cursor agent CLI", kind: "cli" as const, before: null, after: null, result: "failed" as const, method: "installer", detail: redact(String(e)) }));
    save(c); results.push(c.result);
    const cats = await catalogs(ops, (t) => prevCatalog(db, t)).catch((e: unknown) => [{ tool: "catalogs", label: "Model catalogs", kind: "catalog" as const, before: null, after: null, result: "failed" as const, method: "", detail: redact(String(e)) }]);
    for (const i of cats) {
      save(i); results.push(i.result);
      if ("ids" in i && i.ids) db.prepare("INSERT INTO update_catalog_ids (tool, ids, at) VALUES (?, ?, ?) ON CONFLICT(tool) DO UPDATE SET ids = excluded.ids, at = excluded.at").run(i.tool, JSON.stringify(i.ids), now());
    }
    const bad = results.filter((r) => r === "failed" || r === "rolled_back").length;
    const status = bad === 0 ? "ok" : bad === results.length ? "failed" : "partial";
    db.prepare("UPDATE update_runs SET status = ?, finished_at = ? WHERE id = ?").run(status, now(), runId);
    return status;
  } catch (e) {
    db.prepare("UPDATE update_runs SET status = 'failed', reason = ?, finished_at = ? WHERE id = ?").run(redact(String(e)), now(), runId);
    return "failed";
  } finally { g.__cobraUpdating = false; }
}

/** Called every minute. 4:00 AM ET daily (DST-correct), claimed in the DB; waits for active agent runs. */
export async function maybeRunDailyUpdate(db: DB, ops: Ops, now = Date.now()): Promise<string> {
  const c = nyClock(now), mins = c.hour * 60 + c.minute;
  db.prepare("UPDATE update_runs SET status = 'failed', reason = 'interrupted (server restarted mid-update)', finished_at = ? WHERE status = 'running' AND started_at < ?").run(now, now - STALE_MS);
  if (updating()) return "busy";
  let row = db.prepare("SELECT id, status, next_try_at nextTry, attempts, created_at createdAt FROM update_runs WHERE kind = 'scheduled' AND run_date = ?").get(c.date) as { id: number; status: string; nextTry: number | null; attempts: number; createdAt: number } | undefined;
  if (!row) {
    if (mins < UPDATE_HOUR * 60) return "not-due";
    const enabled = !!(db.prepare("SELECT enabled FROM update_settings WHERE id = 1").get() as { enabled: number }).enabled;
    try {
      const r = db.prepare("INSERT INTO update_runs (kind, run_date, status, reason, next_try_at, triggered_by, created_at, finished_at) VALUES ('scheduled', ?, ?, ?, ?, 'scheduler', ?, ?)")
        .run(c.date, enabled ? "waiting" : "skipped", enabled ? (mins >= WAIT_UNTIL_MIN ? "catch-up (server was down at 4:00 AM ET)" : null) : "disabled", now, now, enabled ? null : now);
      if (!enabled) return "disabled";
      row = { id: Number(r.lastInsertRowid), status: "waiting", nextTry: now, attempts: 0, createdAt: now };
    } catch (e) { if (e instanceof Error && /UNIQUE/i.test(e.message)) return "already"; throw e; }
  }
  if (row.status !== "waiting") return "already";
  if ((row.nextTry ?? 0) > now) return "waiting";
  if (activeAgentRuns(db) > 0) {
    // Wait until 6:30 AM ET (or 2.5 h after a catch-up claim), retrying every 15 minutes.
    const deadline = Math.max(now + (WAIT_UNTIL_MIN - mins) * 60_000, row.createdAt + 150 * 60_000);
    if (now + 1 >= deadline || mins >= 23 * 60 + 45) {
      db.prepare("UPDATE update_runs SET status = 'skipped', reason = ?, attempts = attempts + 1, finished_at = ? WHERE id = ?").run(`agent run in progress; waited until ${fmtNy(now)} (${row.attempts + 1} checks)`, now, row.id);
      return "skipped-busy";
    }
    db.prepare("UPDATE update_runs SET next_try_at = ?, attempts = attempts + 1, reason = ? WHERE id = ?").run(now + RETRY_MS, `waiting for an agent run to finish (check ${row.attempts + 1})`, row.id);
    return "waiting";
  }
  const claimed = db.prepare("UPDATE update_runs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'waiting'").run(now, row.id);
  if (!claimed.changes) return "already";
  return executeRun(db, row.id, ops);
}

// ---------- admin ----------
const audit = (db: DB, u: Admin, action: string, detail: string, now: number) =>
  db.prepare("INSERT INTO notification_audit (actor_id, actor_email, action, detail, at) VALUES (?, ?, ?, ?, ?)").run(u.id, u.email, action, detail, now);

export function setUpdatesEnabled(db: DB, u: Admin, enabled: unknown, now = Date.now()) {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can change tool updates");
  if (typeof enabled !== "boolean") throw new CollabError(400, "enabled must be true or false");
  db.prepare("UPDATE update_settings SET enabled = ?, updated_at = ?, updated_by = ? WHERE id = 1").run(enabled ? 1 : 0, now, u.email);
  audit(db, u, "updates_toggle", `daily tool updates ${enabled ? "enabled" : "disabled"}`, now);
}

/** Admin "Run update now": claims a manual run and starts it in the background; returns its id. */
export function startManualRun(db: DB, u: Admin, ops: Ops, now = Date.now()): number {
  if (!isSystemAdmin(u)) throw new CollabError(403, "only system admins can run tool updates");
  if (updating() || db.prepare("SELECT 1 FROM update_runs WHERE status = 'running' AND started_at >= ?").get(now - STALE_MS)) throw new CollabError(409, "an update is already running");
  const n = activeAgentRuns(db);
  if (n > 0) throw new CollabError(409, `${n} agent run(s) in progress; try again when they finish`);
  // Claim + audit together, so a failed audit never leaves a phantom "running" row.
  db.exec("BEGIN IMMEDIATE");
  let id: number;
  try {
    id = Number(db.prepare("INSERT INTO update_runs (kind, run_date, status, triggered_by, created_at, started_at, attempts) VALUES ('manual', ?, 'running', ?, ?, ?, 1)").run(nyClock(now).date, u.email, now, now).lastInsertRowid);
    audit(db, u, "updates_run_now", `manual tool update #${id}`, now);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  void executeRun(db, id, ops);
  return id;
}

export type RunView = { id: number; kind: string; runDate: string; status: string; reason: string | null; triggeredBy: string | null; createdAt: number; startedAt: number | null; finishedAt: number | null; items: Array<{ tool: string; label: string; kind: string; before: string | null; after: string | null; result: string; method: string | null; detail: string | null; at: number }> };

export function listUpdateRuns(db: DB, limit = 30): Omit<RunView, "items">[] {
  return db.prepare("SELECT id, kind, run_date runDate, status, reason, triggered_by triggeredBy, created_at createdAt, started_at startedAt, finished_at finishedAt FROM update_runs ORDER BY id DESC LIMIT ?").all(limit) as Omit<RunView, "items">[];
}
export function getUpdateRun(db: DB, id?: number): RunView | null {
  const r = (id ? db.prepare("SELECT id, kind, run_date runDate, status, reason, triggered_by triggeredBy, created_at createdAt, started_at startedAt, finished_at finishedAt FROM update_runs WHERE id = ?").get(id)
    : db.prepare("SELECT id, kind, run_date runDate, status, reason, triggered_by triggeredBy, created_at createdAt, started_at startedAt, finished_at finishedAt FROM update_runs ORDER BY id DESC LIMIT 1").get()) as Omit<RunView, "items"> | undefined;
  if (!r) return null;
  return { ...r, items: db.prepare("SELECT tool, label, kind, before, after, result, method, detail, at FROM update_items WHERE run_id = ? ORDER BY id").all(r.id) as RunView["items"] };
}
export function updateSettings(db: DB) {
  const s = db.prepare("SELECT enabled, updated_at, updated_by FROM update_settings WHERE id = 1").get() as { enabled: number; updated_at: number | null; updated_by: string | null };
  return { enabled: !!s.enabled, updatedAt: s.updated_at, updatedBy: s.updated_by };
}

/** Next scheduled 4:00 AM ET instant after `now` (DST-correct, by probing minutes). */
export function nextScheduled(db: DB, now = Date.now()): number {
  const today = nyClock(now).date;
  const doneToday = !!db.prepare("SELECT 1 FROM update_runs WHERE kind = 'scheduled' AND run_date = ?").get(today);
  for (let t = Math.floor(now / 60_000) * 60_000 + 60_000; t < now + 3 * 86_400_000; t += 60_000) {
    const c = nyClock(t);
    if (c.hour === UPDATE_HOUR && c.minute === 0 && !(doneToday && c.date === today)) return t;
  }
  return now;
}

/** Lines for the 7 AM admin email: the scheduled run for that ET date (last night's). */
export function updateSummaryLines(db: DB, date: string): string[] {
  const r = db.prepare("SELECT id FROM update_runs WHERE kind = 'scheduled' AND run_date = ?").get(date) as { id: number } | undefined;
  if (!r) return ["  (no scheduled update ran today)"];
  const v = getUpdateRun(db, r.id)!;
  return [`  Status: ${v.status}${v.reason ? ` (${v.reason})` : ""}${v.startedAt ? `, ran ${fmtNy(v.startedAt)}` : ""}`,
    ...v.items.map((i) => `  - ${i.label}: ${i.before ?? "—"} -> ${i.after ?? "—"} [${i.result.replace("_", " ")}]${i.result === "unchanged" ? "" : ` ${i.detail ?? ""}`}`)];
}
