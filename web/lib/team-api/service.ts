// Team API (/api/v1/teams/{teamId}/repos/{repoId}/...): bearer-key ingress, then skills / agents / runs.
// Order of checks on every request: key missing/invalid/revoked → 401; key's team or repo ≠ path → 403;
// rate limit (rate_limits table) → 429; target object not in this team AND repo → 404; wrong method → 405.
// Repo scoping: skills and agents are team objects in Cobra. The API sees (and can write) only those created
// through a key of the same team+repo (api_objects records the source repo). Agents get that repo as default_repo.
// Runs created through the API always run against the key's repo and use the same paths as the UI
// (runDirect / runTeamAgent / skills run), so the launcher, run users, lesson injection and capture apply.
import { randomBytes } from "node:crypto";
import type { DB } from "../db";
import { hit, type Limit } from "../auth/rate-limit";
import { AgentError, createAgent, deleteAgent, getAgent, updateAgent, type TeamAgent } from "../agents";
import { runTeamAgent } from "../agent-run";
import { runDirect, type RunDeps } from "../workflows/service";
import type { Actor } from "../workflows/store";
import { createSkill, deleteSkill, getSkill, SkillError, updateSkill } from "../skills/store";
import * as skillsService from "../skills/service";
import { injectedFor } from "../lessons/inject";
import { apiAudit, resolveKey, type KeyPrincipal } from "./keys";

export type ApiReq = { method: string; teamId: string; repoId: string; path: string[]; auth: string | null; ip: string; body: unknown };
export type ApiRes = { status: number; body: unknown; headers?: Record<string, string> };
export type DepsFor = (tenantId: number, actor: Actor) => RunDeps;

export const API_LIMITS = {
  authFail: { bucket: "api-auth-ip", max: 30, windowMs: 15 * 60 * 1000 }, // bad/missing keys per IP
  key: { bucket: "api-key", max: 120, windowMs: 60 * 1000 }, // requests per key per minute
  runs: { bucket: "api-runs", max: 60, windowMs: 60 * 60 * 1000 }, // run starts per key per hour
} satisfies Record<string, Limit>;

class ApiError extends Error { constructor(public status: number, msg: string, public headers?: Record<string, string>) { super(msg); } }
const j = (status: number, body: unknown): ApiRes => ({ status, body });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const intId = (v: string | undefined) => (v && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : null);

export function bearer(h: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h ?? "");
  return m ? m[1] : null;
}

const actorOf = (p: KeyPrincipal): Actor => ({ id: p.userId, email: p.email, role: "team_lead", tenantId: p.tenantId });

function limited(db: DB, l: Limit, key: string, now: number) {
  const s = hit(db, l, key, now);
  if (s.limited) throw new ApiError(429, "rate limit exceeded", { "Retry-After": String(s.retryAfterSec) });
}

export function handle(db: DB, r: ApiReq, depsFor: DepsFor, now = Date.now()): ApiRes {
  let p: KeyPrincipal | null = null;
  try {
    const key = bearer(r.auth);
    p = resolveKey(db, key, now);
    if (!p) { limited(db, API_LIMITS.authFail, r.ip || "unknown", now); return j(401, { error: key ? "invalid or revoked API key" : "missing API key (Authorization: Bearer <key>)" }); }
    if (String(p.tenantId) !== r.teamId || String(p.repoId) !== r.repoId) return j(403, { error: `this key is not valid for this team and repo; it is for /api/v1/teams/${p.tenantId}/repos/${p.repoId} (${p.repo})` });
    limited(db, API_LIMITS.key, String(p.keyId), now);
    const res = route(db, p, r, depsFor, now);
    if (r.method !== "GET") apiAudit(db, { tenantId: p.tenantId, repoId: p.repoId, keyId: p.keyId, actor: p.email, action: `${r.method} ${r.path[0] ?? ""}`, target: r.path.join("/"), status: res.status, at: now });
    return res;
  } catch (e) {
    const status = e instanceof ApiError ? e.status : e instanceof SkillError ? e.status : e instanceof AgentError ? e.status : 500;
    const msg = e instanceof SkillError ? e.errors[0] : e instanceof Error && status !== 500 ? e.message : "internal error";
    if (p && r.method !== "GET" && String(p.tenantId) === r.teamId && String(p.repoId) === r.repoId)
      apiAudit(db, { tenantId: p.tenantId, repoId: p.repoId, keyId: p.keyId, actor: p.email, action: `${r.method} ${r.path[0] ?? ""}`, target: r.path.join("/"), status, at: now });
    if (status === 500) throw e;
    return { status, body: { error: msg }, headers: e instanceof ApiError ? e.headers : undefined };
  }
}

const notAllowed = (allow: string): never => { throw new ApiError(405, `method not allowed (allowed: ${allow})`, { Allow: allow }); };

function route(db: DB, p: KeyPrincipal, r: ApiReq, depsFor: DepsFor, now: number): ApiRes {
  const [res, rawId, action, ...rest] = r.path;
  if (rest.length) throw new ApiError(404, "not found");
  const u = actorOf(p), m = r.method, b = isObj(r.body) ? r.body : {};
  if (res === undefined) {
    // The base path itself: a small index so a first "does my key work?" call succeeds.
    if (m !== "GET") return notAllowed("GET");
    const team = db.prepare("SELECT name FROM tenants WHERE id = ?").get(p.tenantId) as { name: string } | undefined;
    return j(200, { ok: true, team: { id: p.tenantId, name: team?.name ?? null }, repo: { id: p.repoId, name: p.repo }, key: { id: p.keyId, prefix: p.prefix },
      endpoints: ["skills", "agents", "runs"].map((x) => `/api/v1/teams/${p.tenantId}/repos/${p.repoId}/${x}`) });
  }
  if (res === "skills" || res === "agents") {
    const kind = res === "skills" ? "skill" : "agent";
    if (rawId === undefined) {
      if (m === "GET") return j(200, { [res]: listScoped(db, p, kind) });
      if (m === "POST") return j(201, kind === "skill" ? { skill: createScopedSkill(db, p, u, b, now) } : { agent: createScopedAgent(db, p, u, b, now) });
      return notAllowed("GET, POST");
    }
    const id = intId(rawId);
    if (id === null || !inScope(db, p, kind, id)) throw new ApiError(404, `${kind} not found`);
    if (action === "run") {
      if (m !== "POST") return notAllowed("POST");
      return createRun(db, p, u, { ...b, skillId: kind === "skill" ? id : undefined, agentId: kind === "agent" ? id : undefined, start: true }, depsFor, now);
    }
    if (action !== undefined) throw new ApiError(404, "not found");
    if (m === "GET") return j(200, kind === "skill" ? { skill: getSkill(db, u, id) } : { agent: agentById(db, p.tenantId, id) });
    if (m === "PUT") return j(200, kind === "skill" ? updateScopedSkill(db, u, id, b, now) : { agent: updateScopedAgent(db, p, u, id, b, now) });
    if (m === "DELETE") {
      if (kind === "skill") deleteSkill(db, u, id, now); else deleteAgent(db, u, agentById(db, p.tenantId, id)!.name, now);
      if (kind === "agent") agentAudit(db, p, "api_agent_delete", `agent #${id}`, now);
      db.prepare("DELETE FROM api_objects WHERE kind = ? AND object_id = ?").run(kind, id);
      return j(200, { ok: true });
    }
    return notAllowed("GET, PUT, DELETE");
  }
  if (res === "runs") {
    if (rawId === undefined) {
      if (m === "GET") return j(200, { runs: (db.prepare("SELECT * FROM api_runs WHERE tenant_id = ? AND repo_id = ? ORDER BY created_at DESC LIMIT 100").all(p.tenantId, p.repoId) as RunRow[]).map((x) => runView(db, x)) });
      if (m === "POST") return createRun(db, p, u, b, depsFor, now);
      return notAllowed("GET, POST");
    }
    const rec = findRun(db, p, rawId);
    if (!rec) throw new ApiError(404, "run not found");
    if (action === "start" || action === "instantiate") {
      if (m !== "POST") return notAllowed("POST");
      return startRun(db, p, u, rec, b, depsFor, now);
    }
    if (action !== undefined) throw new ApiError(404, "not found");
    if (m === "GET") return j(200, { run: runView(db, rec) });
    if (m === "PUT") return j(200, { run: runView(db, updateRun(db, rec, b, now)) });
    return notAllowed("GET, PUT"); // DELETE included: runs are history and are never deleted
  }
  throw new ApiError(404, "not found");
}

// ---------- skills / agents ----------
function inScope(db: DB, p: KeyPrincipal, kind: "skill" | "agent", id: number): boolean {
  const o = db.prepare("SELECT 1 FROM api_objects WHERE kind = ? AND object_id = ? AND tenant_id = ? AND repo_id = ?").get(kind, id, p.tenantId, p.repoId);
  if (!o) return false;
  return kind === "skill" ? !!db.prepare("SELECT 1 FROM skills WHERE id = ? AND tenant_id = ?").get(id, p.tenantId) : !!agentById(db, p.tenantId, id);
}
function agentById(db: DB, tenantId: number, id: number): TeamAgent | null {
  const r = db.prepare("SELECT name FROM team_agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL").get(id, tenantId) as { name: string } | undefined;
  return r ? getAgent(db, tenantId, r.name) : null;
}
function listScoped(db: DB, p: KeyPrincipal, kind: "skill" | "agent") {
  const ids = (db.prepare("SELECT object_id AS id FROM api_objects WHERE kind = ? AND tenant_id = ? AND repo_id = ? ORDER BY object_id").all(kind, p.tenantId, p.repoId) as { id: number }[]).map((x) => x.id);
  return ids.map((id) => (kind === "skill" ? getSkill(db, { role: "member", tenantId: p.tenantId }, id) : agentById(db, p.tenantId, id))).filter(Boolean);
}
const track = (db: DB, p: KeyPrincipal, kind: "skill" | "agent", id: number, now: number) =>
  db.prepare("INSERT INTO api_objects (kind, object_id, tenant_id, repo_id, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(kind, id, p.tenantId, p.repoId, p.keyId, now);
const agentAudit = (db: DB, p: KeyPrincipal, action: string, detail: string, now: number, name = "") =>
  db.prepare("INSERT INTO agent_audit (tenant_id, actor_id, actor_email, action, agent_name, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(p.tenantId, p.userId, p.email, action, name, `${detail} via API key #${p.keyId} (repo ${p.repo})`.slice(0, 1000), now);

function createScopedSkill(db: DB, p: KeyPrincipal, u: Actor, b: Record<string, unknown>, now: number) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const s = createSkill(db, u, { name: b.name, description: b.description, body: b.body, plan: b.plan, kind: b.kind }, now);
    track(db, p, "skill", s.id, now);
    db.exec("COMMIT");
    return s;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function updateScopedSkill(db: DB, u: Actor, id: number, b: Record<string, unknown>, now: number) {
  return updateSkill(db, u, id, { name: b.name, description: b.description, body: b.body, plan: b.plan, kind: b.kind }, "edited via API", now);
}
/** An agent's repo is the key's repo; a skill reference must be a skill visible to this key. */
function agentInput(db: DB, p: KeyPrincipal, b: Record<string, unknown>) {
  if (b.defaultRepo !== undefined && b.defaultRepo !== null && b.defaultRepo !== p.repo) throw new ApiError(400, `defaultRepo must be this key's repo (${p.repo})`);
  let skillRef = b.skillRef;
  if (b.skillId !== undefined) skillRef = b.skillId === null ? null : `sop:${b.skillId}`;
  if (typeof skillRef === "string") {
    const m = /^sop:(\d+)$/.exec(skillRef);
    if (!m || !inScope(db, p, "skill", Number(m[1]))) throw new ApiError(404, "skill not found");
  }
  const { sourceUrl: _s, ...rest } = b; void _s;
  return { ...rest, defaultRepo: p.repo, ...(skillRef !== undefined ? { skillRef } : {}) };
}
function createScopedAgent(db: DB, p: KeyPrincipal, u: Actor, b: Record<string, unknown>, now: number) {
  const input = agentInput(db, p, b);
  db.exec("BEGIN IMMEDIATE");
  try {
    const a = createAgent(db, u, input, now);
    track(db, p, "agent", a.id, now);
    agentAudit(db, p, "api_agent_create", `created agent '${a.name}'`, now, a.name);
    db.exec("COMMIT");
    return a;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function updateScopedAgent(db: DB, p: KeyPrincipal, u: Actor, id: number, b: Record<string, unknown>, now: number) {
  const cur = agentById(db, p.tenantId, id)!;
  const a = updateAgent(db, u, cur.name, agentInput(db, p, b), now);
  agentAudit(db, p, "api_agent_update", `updated agent '${a.name}'`, now, a.name);
  return a;
}

// ---------- runs ----------
type RunRow = { id: string; tenant_id: number; repo_id: number; key_id: number | null; kind: "skill" | "agent" | "engine"; ref: string; prompt: string; mode: string; status: "pending" | "started" | "cancelled"; run_id: string | null; rerun_of: string | null; meta_json: string; created_at: number; updated_at: number };

function findRun(db: DB, p: KeyPrincipal, id: string): RunRow | null {
  if (!/^[\w-]{1,80}$/.test(id)) return null;
  return (db.prepare("SELECT * FROM api_runs WHERE (id = ? OR run_id = ?) AND tenant_id = ? AND repo_id = ?").get(id, id, p.tenantId, p.repoId) as RunRow | undefined) ?? null;
}
function runView(db: DB, r: RunRow) {
  const run = r.run_id ? db.prepare("SELECT status, started_at AS startedAt, ended_at AS endedAt, error, mode FROM runs WHERE id = ? AND tenant_id = ?").get(r.run_id, r.tenant_id) as Record<string, unknown> | undefined : undefined;
  return { id: r.id, status: r.status, kind: r.kind, ref: r.kind === "engine" ? r.ref : Number(r.ref), prompt: r.prompt, mode: r.mode, meta: JSON.parse(r.meta_json), rerunOf: r.rerun_of,
    runId: r.run_id, url: r.run_id ? `/runs/${r.run_id}` : null, run: run ?? null, injectedLessons: r.run_id ? injectedFor(db, r.tenant_id, r.run_id).map((l) => l.id) : [], createdAt: r.created_at, updatedAt: r.updated_at };
}
function cleanMeta(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw new ApiError(400, "meta must be an object");
  const s = JSON.stringify(v);
  if (s.length > 4000) throw new ApiError(400, "meta must be at most 4000 characters as JSON");
  return s;
}
function cleanRunFields(b: Record<string, unknown>) {
  if (b.prompt !== undefined && typeof b.prompt !== "string") throw new ApiError(400, "prompt must be text");
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : undefined;
  if (prompt !== undefined && prompt.length > 4000) throw new ApiError(400, "prompt must be at most 4000 characters");
  if (b.mode !== undefined && b.mode !== "simulated" && b.mode !== "real") throw new ApiError(400, "mode must be simulated or real");
  return { prompt, mode: b.mode as "simulated" | "real" | undefined, meta: cleanMeta(b.meta) };
}

function createRun(db: DB, p: KeyPrincipal, u: Actor, b: Record<string, unknown>, depsFor: DepsFor, now: number): ApiRes {
  const f = cleanRunFields(b);
  const has = [b.skillId, b.agentId].filter((v) => v !== undefined && v !== null).length;
  if (has > 1) throw new ApiError(400, "give one of skillId or agentId");
  let kind: RunRow["kind"], ref: string;
  if (b.skillId !== undefined && b.skillId !== null) {
    const id = intId(String(b.skillId)); if (id === null || !inScope(db, p, "skill", id)) throw new ApiError(404, "skill not found");
    if (b.engine !== undefined) throw new ApiError(400, "engine is set by the skill's steps; omit it");
    kind = "skill"; ref = String(id);
  } else if (b.agentId !== undefined && b.agentId !== null) {
    const id = intId(String(b.agentId)); if (id === null || !inScope(db, p, "agent", id)) throw new ApiError(404, "agent not found");
    const a = agentById(db, p.tenantId, id)!;
    if (b.engine !== undefined && b.engine !== a.engine) throw new ApiError(400, `agent '${a.name}' runs on ${a.engine}; omit engine or match it`);
    kind = "agent"; ref = String(id);
  } else {
    if (!str(b.engine)) throw new ApiError(400, "give skillId, agentId, or engine with a prompt");
    if (!f.prompt) throw new ApiError(400, "prompt is required for an engine run");
    kind = "engine"; ref = str(b.engine)!;
  }
  if (b.start !== undefined && typeof b.start !== "boolean") throw new ApiError(400, "start must be true or false");
  const id = `apr_${now.toString(36)}${randomBytes(4).toString("hex")}`;
  db.prepare("INSERT INTO api_runs (id, tenant_id, repo_id, key_id, kind, ref, prompt, mode, status, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
    .run(id, p.tenantId, p.repoId, p.keyId, kind, ref, f.prompt ?? "", f.mode ?? "simulated", f.meta ?? "{}", now, now);
  const rec = db.prepare("SELECT * FROM api_runs WHERE id = ?").get(id) as RunRow;
  if (b.start === false) return j(201, { run: runView(db, rec) });
  const out = instantiate(db, p, u, rec, depsFor, now);
  if (out.status >= 400) { db.prepare("DELETE FROM api_runs WHERE id = ? AND status = 'pending'").run(id); return out; }
  return out;
}

/** Starts a pending API run in place; a started or cancelled one is re-instantiated as a NEW run (history never mutated). */
function startRun(db: DB, p: KeyPrincipal, u: Actor, rec: RunRow, b: Record<string, unknown>, depsFor: DepsFor, now: number): ApiRes {
  const f = cleanRunFields(b);
  if (rec.status === "pending") {
    if (f.prompt !== undefined || f.mode !== undefined || f.meta !== undefined)
      db.prepare("UPDATE api_runs SET prompt = COALESCE(?, prompt), mode = COALESCE(?, mode), meta_json = COALESCE(?, meta_json), updated_at = ? WHERE id = ?").run(f.prompt ?? null, f.mode ?? null, f.meta ?? null, now, rec.id);
    return instantiate(db, p, u, db.prepare("SELECT * FROM api_runs WHERE id = ?").get(rec.id) as RunRow, depsFor, now);
  }
  if (rec.kind !== "engine" && !inScope(db, p, rec.kind, Number(rec.ref))) throw new ApiError(404, `${rec.kind} not found`);
  const id = `apr_${now.toString(36)}${randomBytes(4).toString("hex")}`;
  db.prepare("INSERT INTO api_runs (id, tenant_id, repo_id, key_id, kind, ref, prompt, mode, status, rerun_of, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)")
    .run(id, p.tenantId, p.repoId, p.keyId, rec.kind, rec.ref, f.prompt ?? rec.prompt, f.mode ?? rec.mode, rec.id, f.meta ?? rec.meta_json, now, now);
  const out = instantiate(db, p, u, db.prepare("SELECT * FROM api_runs WHERE id = ?").get(id) as RunRow, depsFor, now);
  if (out.status >= 400) db.prepare("DELETE FROM api_runs WHERE id = ? AND status = 'pending'").run(id);
  return out;
}

/** The one place API runs execute: the same service functions the UI routes call. */
function instantiate(db: DB, p: KeyPrincipal, u: Actor, rec: RunRow, depsFor: DepsFor, now: number): ApiRes {
  limited(db, API_LIMITS.runs, String(p.keyId), now);
  const deps = depsFor(p.tenantId, u);
  let r: { status: number; body: unknown };
  if (rec.kind === "skill") {
    r = skillsService.run(db, u, Number(rec.ref), { inputs: rec.prompt ? { prompt: rec.prompt, instructions: rec.prompt, task: rec.prompt } : {}, mode: rec.mode, repo: p.repo }, deps);
  } else if (rec.kind === "agent") {
    const a = agentById(db, p.tenantId, Number(rec.ref));
    if (!a) throw new ApiError(404, "agent not found");
    r = runTeamAgent(db, u, a.name, { repo: p.repo, mode: rec.mode, instructions: rec.prompt || undefined }, deps);
  } else {
    const d = runDirect(db, u, { engine: rec.ref, prompt: rec.prompt, repo: p.repo, mode: rec.mode, purpose: `API run (key #${p.keyId})` }, deps);
    r = { status: d.status, body: d.body };
  }
  if (r.status >= 400) return { status: r.status, body: r.body };
  const runId = String((r.body as { id: string }).id);
  db.prepare("UPDATE api_runs SET status = 'started', run_id = ?, updated_at = ? WHERE id = ?").run(runId, now, rec.id);
  return j(201, { run: runView(db, db.prepare("SELECT * FROM api_runs WHERE id = ?").get(rec.id) as RunRow) });
}

/** PUT: metadata always; prompt/mode while pending; {cancel:true} cancels a pending run. */
function updateRun(db: DB, rec: RunRow, b: Record<string, unknown>, now: number): RunRow {
  const f = cleanRunFields(b);
  if (b.cancel !== undefined && b.cancel !== true) throw new ApiError(400, "cancel must be true");
  if (rec.status !== "pending" && (f.prompt !== undefined || f.mode !== undefined)) throw new ApiError(409, "prompt and mode can only change before the run starts (start a new run instead)");
  if (b.cancel === true && rec.status === "started") throw new ApiError(409, "a started run can't be cancelled through the API");
  const status = b.cancel === true ? "cancelled" : rec.status;
  db.prepare("UPDATE api_runs SET prompt = COALESCE(?, prompt), mode = COALESCE(?, mode), meta_json = COALESCE(?, meta_json), status = ?, updated_at = ? WHERE id = ?").run(f.prompt ?? null, f.mode ?? null, f.meta ?? null, status, now, rec.id);
  return db.prepare("SELECT * FROM api_runs WHERE id = ?").get(rec.id) as RunRow;
}
