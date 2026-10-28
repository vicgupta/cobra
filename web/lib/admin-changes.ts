// System-admin "what changed" sections for the all-teams daily digest (last 24 h): software versions,
// Cobra deploys, usage/analytics, errors, admin changes (audit tables) and system health. Pure Node: the
// host facts (git, backups, process) are injected as SysInfo so tests use fixed values. Never includes
// secret values: provider/credential lines carry names and engines only, and any long token-like string
// in an audit detail is masked.
import type { DB } from "./db";
import { fmtNy } from "./digest";

const DAY = 24 * 60 * 60 * 1000;
export type SysInfo = {
  nodeVersion: string;
  appCommit: string | null;
  /** Commit subjects in (lastReportedCommit, appCommit], newest first; null = not available. */
  commitSubjects?: (from: string, to: string) => string[] | null;
  processUptimeSec: number | null;
  backups: Array<{ name: string; mtime: number }> | null;
  diskFreeBytes: number | null; diskTotalBytes: number | null; dbBytes: number | null; hostUptimeSec: number | null;
};
export type AdminSection = { title: string; lines: string[] };
type N = number;

/** Masks anything that looks like a credential value (long base64/hex-ish runs, sk-/ghp_ style keys). */
export const maskSecrets = (s: string) => s.replace(/\b(?:sk|ghp|gho|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{6,}/g, "[redacted]").replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]");
const short = (c: string | null) => (c ? c.slice(0, 8) : "unknown");
const gb = (b: N | null) => (b == null ? "n/a" : `${(b / 1e9).toFixed(1)} GB`);
const mb = (b: N | null) => (b == null ? "n/a" : `${(b / 1e6).toFixed(1)} MB`);
const hrs = (s: N | null) => (s == null ? "n/a" : s >= 172800 ? `${(s / 86400).toFixed(1)} days` : `${(s / 3600).toFixed(1)} h`);
const or = (rows: string[], none: string) => (rows.length ? rows : [none]);

const TOOLS: Array<[string, string]> = [["claude-code", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"], ["cursor", "Cursor agent"]];

export function lastReportedCommit(db: DB): string | null {
  return (db.prepare("SELECT last_commit FROM notification_settings WHERE id = 1").get() as { last_commit: string | null } | undefined)?.last_commit ?? null;
}
export function setLastReportedCommit(db: DB, c: string | null) {
  if (c) db.prepare("UPDATE notification_settings SET last_commit = ? WHERE id = 1").run(c);
}

export function buildAdminChanges(db: DB, now: number, sys: SysInfo): AdminSection[] {
  const since = now - DAY;
  const q = <R>(sql: string, ...a: Array<string | N>) => db.prepare(sql).all(...a) as R[];
  const one = (sql: string, ...a: Array<string | N>) => Number((db.prepare(sql).get(...a) as { n: N | null }).n ?? 0);
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const out: AdminSection[] = [];

  // ---- software versions ----
  const items = q<{ label: string; before: string | null; after: string | null; result: string; method: string | null; detail: string | null; at: N; kind: string }>(
    "SELECT i.label, i.before, i.after, i.result, i.method, i.detail, i.at, r.kind FROM update_items i JOIN update_runs r ON r.id = i.run_id WHERE i.at >= ? AND i.result <> 'unchanged' ORDER BY i.at, i.id", since);
  const runs = q<{ kind: string; status: string; reason: string | null; started_at: N | null; created_at: N }>("SELECT kind, status, reason, started_at, created_at FROM update_runs WHERE created_at >= ? ORDER BY created_at", since);
  const current = TOOLS.map(([tool, label]) => {
    const r = db.prepare("SELECT COALESCE(after, before) v, at FROM update_items WHERE tool = ? AND COALESCE(after, before) IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1").get(tool) as { v: string; at: N } | undefined;
    return r ? `${label}: ${r.v} (as of ${fmtNy(r.at)})` : null;
  }).filter((x): x is string => !!x);
  out.push({ title: "SOFTWARE VERSIONS (last 24 h)", lines: [
    ...or(runs.map((r) => `Update run (${r.kind}): ${r.status}${r.reason ? ` (${r.reason})` : ""}, ${fmtNy(r.started_at ?? r.created_at)}`), "No tool update runs in the last 24 h"),
    ...or(items.map((i) => `${i.result === "failed" || i.result === "rolled_back" ? "!! FAILED: " : ""}${i.label}: ${i.before ?? "-"} -> ${i.after ?? "-"} [${i.result.replace("_", " ")}]${i.method ? ` via ${i.method}` : ""}${i.detail ? `; ${maskSecrets(i.detail)}` : ""}`), "No version changes"),
    "Current versions:", ...current.map((c) => `  ${c}`), `  Node: ${sys.nodeVersion}`, `  Cobra app commit: ${short(sys.appCommit)}`,
  ] });

  // ---- deploys ----
  const last = lastReportedCommit(db);
  const dep: string[] = [];
  if (!sys.appCommit) dep.push("App commit unknown");
  else if (!last) dep.push(`Now running ${short(sys.appCommit)} (first report; no earlier commit recorded)`);
  else if (last === sys.appCommit) dep.push(`No deploys: still ${short(sys.appCommit)}`);
  else {
    dep.push(`Deployed: ${short(last)} -> ${short(sys.appCommit)}`);
    const subj = sys.commitSubjects?.(last, sys.appCommit) ?? null;
    if (subj?.length) dep.push(...subj.slice(0, 25).map((s) => `  - ${s}`), ...(subj.length > 25 ? [`  ... and ${subj.length - 25} more`] : []));
  }
  if (sys.processUptimeSec != null) dep.push(`Service (cobra-web) up ${hrs(sys.processUptimeSec)}${sys.processUptimeSec < 86400 ? `, restarted ${fmtNy(now - sys.processUptimeSec * 1000)}` : ""}`);
  out.push({ title: "COBRA DEPLOYS", lines: dep });

  // ---- usage & analytics ----
  const runRows = q<{ team: string; engine: string; status: string; n: N }>("SELECT t.name team, COALESCE(r.engine,'n/a') engine, COALESCE(r.status,'unknown') status, COUNT(*) n FROM runs r JOIN tenants t ON t.id = r.tenant_id WHERE r.started_at >= ? GROUP BY 1,2,3 ORDER BY 1,2,3", since);
  const usage = db.prepare("SELECT SUM(COALESCE(input_tokens,0)) tin, SUM(COALESCE(output_tokens,0)) tout, SUM(COALESCE(cached_tokens,0)) tc, SUM(cost_usd) cost, COUNT(cost_usd) costed FROM run_usage WHERE created_at >= ?").get(since) as { tin: N | null; tout: N | null; tc: N | null; cost: N | null; costed: N };
  const created = (t: string, extra = "") => has(t) ? one(`SELECT COUNT(*) n FROM ${t} WHERE created_at >= ?${extra}`, since) : 0;
  const deleted = (t: string) => has(t) ? one(`SELECT COUNT(*) n FROM ${t} WHERE deleted_at >= ?`, since) : 0;
  const skillDel = one("SELECT COUNT(*) n FROM skill_audit WHERE action = 'delete' AND at >= ?", since);
  const joins = q<{ status: string; n: N }>("SELECT status, COUNT(*) n FROM join_requests WHERE created_at >= ? GROUP BY 1 ORDER BY 1", since);
  out.push({ title: "USAGE & ANALYTICS (last 24 h)", lines: [
    "Runs by team / engine / status:", ...or(runRows.map((r) => `  ${r.team} / ${r.engine} / ${r.status}: ${r.n}`), "  No runs"),
    `Tokens: ${((usage.tin ?? 0) + (usage.tout ?? 0)).toLocaleString("en-US")} (in ${(usage.tin ?? 0).toLocaleString("en-US")}, out ${(usage.tout ?? 0).toLocaleString("en-US")}, cached ${(usage.tc ?? 0).toLocaleString("en-US")}); cost ${usage.costed ? `$${(usage.cost ?? 0).toFixed(2)}` : "n/a"}`,
    `Active users (signed in): ${one("SELECT COUNT(DISTINCT user_id) n FROM sessions WHERE created_at >= ?", since)}; new sessions: ${created("sessions")}; live sessions: ${one("SELECT COUNT(*) n FROM sessions WHERE expires_at > ?", now)}`,
    `Sign-ups (new users): ${created("users")}; new teams: ${created("tenants")}; join requests: ${joins.length ? joins.map((j) => `${j.n} ${j.status}`).join(", ") : "0"}`,
    `Agents: ${created("team_agents")} created, ${deleted("team_agents")} deleted; tasks: ${created("tasks")} created, ${deleted("tasks")} deleted; skills: ${created("skills")} created, ${skillDel} deleted`,
    `Totals: ${one("SELECT COUNT(*) n FROM users")} users, ${one("SELECT COUNT(*) n FROM tenants")} teams`,
  ] });

  // ---- errors ----
  const failedRuns = q<{ team: string; engine: string; agent: string; n: N }>("SELECT t.name team, COALESCE(r.engine,'n/a') engine, COALESCE(r.agent,'n/a') agent, COUNT(*) n FROM runs r JOIN tenants t ON t.id = r.tenant_id WHERE r.status = 'failed' AND r.started_at >= ? GROUP BY 1,2,3 ORDER BY n DESC LIMIT 15", since);
  const mailFail = [
    ...q<{ kind: string; send_date: string; error: string | null; at: N }>("SELECT kind, send_date, error, at FROM notification_sends WHERE status = 'failed' AND at >= ? ORDER BY at", since).map((r) => `Admin digest (${r.kind} ${r.send_date}) failed: ${maskSecrets(r.error ?? "")}`),
    ...q<{ team: string; kind: string; error: string | null }>("SELECT t.name team, s.kind, s.error FROM team_notification_sends s JOIN tenants t ON t.id = s.tenant_id WHERE s.status = 'failed' AND s.at >= ? ORDER BY s.at", since).map((r) => `Team digest ${r.team} (${r.kind}) failed: ${maskSecrets(r.error ?? "")}`),
  ];
  const stepFail = has("run_step_events") ? one("SELECT COUNT(*) n FROM run_step_events WHERE status = 'failed' AND at >= ?", since) : 0;
  out.push({ title: "ERRORS (last 24 h)", lines: [
    "Failed runs:", ...or(failedRuns.map((f) => `  ${f.team} / ${f.engine} / ${f.agent}: ${f.n}`), "  No failed runs"),
    `Failed run steps: ${stepFail}`,
    "Update failures:", ...or(items.filter((i) => i.result === "failed" || i.result === "rolled_back").map((i) => `  !! ${i.label}: ${i.result.replace("_", " ")}`).concat(runs.filter((r) => r.status === "failed" || r.status === "partial").map((r) => `  !! update run ${r.status}${r.reason ? `: ${r.reason}` : ""}`)), "  No update failures"),
    "Email send failures:", ...or(mailFail.map((m) => `  ${m}`), "  No email send failures"),
  ] });

  // ---- admin-relevant changes ----
  const prov = q<{ team: string | null; actor: string; engine: string; detail: string | null; om: string | null; nm: string | null; oe: string | null; ne: string | null; at: N }>(
    "SELECT t.name team, p.actor_email actor, p.engine, p.detail, p.old_model om, p.new_model nm, p.old_effort oe, p.new_effort ne, p.at FROM provider_audit p LEFT JOIN tenants t ON t.id = p.tenant_id WHERE p.at >= ? ORDER BY p.at", since)
    .map((p) => `${fmtNy(p.at)} ${p.team ?? "global"} / ${p.engine}: ${p.detail ? maskSecrets(p.detail) : `default model ${p.om ?? "-"} -> ${p.nm ?? "-"}, effort ${p.oe ?? "-"} -> ${p.ne ?? "-"}`} (by ${p.actor})`);
  const team = q<{ team: string; actor: string; action: string; target: string | null; detail: string; at: N }>("SELECT t.name team, a.actor_email actor, a.action, a.target_email target, a.detail, a.at FROM team_audit a JOIN tenants t ON t.id = a.tenant_id WHERE a.at >= ? ORDER BY a.at LIMIT 50", since)
    .map((a) => `${fmtNy(a.at)} ${a.team}: ${a.action}${a.target ? ` ${a.target}` : ""}${a.detail ? ` (${maskSecrets(a.detail)})` : ""} by ${a.actor}`);
  const repo = q<{ team: string; actor: string; action: string; repo: string; at: N }>("SELECT t.name team, a.actor_email actor, a.action, a.repo, a.at FROM repo_audit a JOIN tenants t ON t.id = a.tenant_id WHERE a.at >= ? ORDER BY a.at LIMIT 50", since)
    .map((a) => `${fmtNy(a.at)} ${a.team}: ${a.action} ${a.repo} by ${a.actor}`);
  const skill = q<{ team: string | null; actor: string; action: string; detail: string; at: N }>("SELECT t.name team, a.actor_email actor, a.action, a.detail, a.at FROM skill_audit a LEFT JOIN tenants t ON t.id = a.tenant_id WHERE a.at >= ? ORDER BY a.at LIMIT 50", since)
    .map((a) => `${fmtNy(a.at)} ${a.team ?? "global"}: ${a.action}${a.detail ? ` (${maskSecrets(a.detail).slice(0, 120)})` : ""} by ${a.actor}`);
  const notif = q<{ actor: string; action: string; detail: string; at: N }>("SELECT actor_email actor, action, detail, at FROM notification_audit WHERE at >= ? ORDER BY at", since).map((a) => `${fmtNy(a.at)} ${a.action}: ${a.detail} by ${a.actor}`);
  out.push({ title: "ADMIN CHANGES (last 24 h)", lines: [
    "Provider credentials / auth / defaults (names only):", ...or(prov.map((l) => `  ${l}`), "  No changes"),
    "Teams and roles:", ...or(team.map((l) => `  ${l}`), "  No changes"),
    "Repos:", ...or(repo.map((l) => `  ${l}`), "  No changes"),
    "Skills:", ...or(skill.map((l) => `  ${l}`), "  No changes"),
    "Notification settings:", ...or(notif.map((l) => `  ${l}`), "  No changes"),
  ] });

  // ---- system health ----
  const b = sys.backups;
  const newest = b ? [...b].sort((x, y) => y.mtime - x.mtime).slice(0, 3) : [];
  out.push({ title: "SYSTEM HEALTH", lines: [
    `Disk free: ${gb(sys.diskFreeBytes)} of ${gb(sys.diskTotalBytes)}${sys.diskFreeBytes != null && sys.diskTotalBytes ? ` (${Math.round((100 * sys.diskFreeBytes) / sys.diskTotalBytes)}% free)` : ""}`,
    `Database size: ${mb(sys.dbBytes)}; schema version ${(db.prepare("PRAGMA user_version").get() as { user_version: N }).user_version}`,
    b == null ? "DB backups: not readable" : `DB backups: ${b.length} file(s)${newest.length ? `; newest: ${newest.map((x) => `${x.name} (${fmtNy(x.mtime)})`).join(", ")}` : ""}`,
    `Service uptime: ${hrs(sys.processUptimeSec)}; host uptime: ${hrs(sys.hostUptimeSec)}`,
  ] });
  return out;
}
