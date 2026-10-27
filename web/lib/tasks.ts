// Tasks: run a team agent (optionally with one skill instead of its own prompt/skill) on a cron schedule
// (America/New_York) or on demand. Team-scoped; other teams get 404. Edit/delete: the creator, team leads,
// the designated lead and admins (same rule as agents). Disabled by default. Names are lowercase slugs.
import type { DB } from "./db";
import { AgentError, canEditAgent, checkSkillRef, getAgent, textSkillsDir, type AgentUser } from "./agents";
import { checkTeamRepo } from "./repos";
import { parseCron } from "./cron";

export const TASK_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;
export const TASK_INSTRUCTIONS_MAX = 4000;
export class TaskError extends AgentError {}

export type Task = {
  id: number; tenantId: number; name: string; agent: string; skillRef: string | null; cron: string | null; enabled: boolean; mode: "simulated" | "real";
  repo: string | null; instructions: string | null; lastFire: number | null; createdBy: number | null; createdByEmail: string | null; createdAt: number; updatedAt: number;
};
type Input = { name?: unknown; agent?: unknown; skillRef?: unknown; cron?: unknown; enabled?: unknown; mode?: unknown; repo?: unknown; instructions?: unknown };

const COLS = `t.id, t.tenant_id AS tenantId, t.name, t.agent, t.skill_ref AS skillRef, t.cron, t.enabled, t.mode, t.repo, t.instructions, t.last_fire AS lastFire,
  t.created_by AS createdBy, u.email AS createdByEmail, t.created_at AS createdAt, t.updated_at AS updatedAt`;
const plain = (r: unknown): Task => { const t = { ...(r as Task) }; t.enabled = !!t.enabled; t.mode = t.mode === "real" ? "real" : "simulated"; return t; };

export function listTasks(db: DB, tenantId: number): Task[] {
  return db.prepare(`SELECT ${COLS} FROM tasks t LEFT JOIN users u ON u.id = t.created_by WHERE t.tenant_id = ? AND t.deleted_at IS NULL ORDER BY t.name`).all(tenantId).map(plain);
}
/** Team-scoped: a task of another team is null (404). */
export function getTask(db: DB, tenantId: number, id: number): Task | null {
  const r = Number.isInteger(id) ? db.prepare(`SELECT ${COLS} FROM tasks t LEFT JOIN users u ON u.id = t.created_by WHERE t.tenant_id = ? AND t.id = ? AND t.deleted_at IS NULL`).get(tenantId, id) : undefined;
  return r ? plain(r) : null;
}
export const canEditTask = (u: AgentUser, t: Pick<Task, "createdBy">, db?: DB) => canEditAgent(u, t, db);
const DENY = "only the task's creator, team leads, the designated lead and admins can";

function validate(db: DB, tenantId: number, b: Input, cur: Task | null, textDir = textSkillsDir()) {
  const pick = <T,>(v: unknown, old: T) => (v === undefined && cur ? old : v);
  const rawName = pick(b.name, cur?.name);
  const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
  if (!TASK_NAME_RE.test(name)) throw new TaskError(400, "name must be lowercase letters, digits and '-', starting with a letter (max 63)");
  const rawAgent = pick(b.agent, cur?.agent);
  const agentName = typeof rawAgent === "string" ? rawAgent.trim().toLowerCase() : "";
  if (!agentName) throw new TaskError(400, "pick an agent");
  const agent = getAgent(db, tenantId, agentName);
  if (!agent) throw new TaskError(400, `agent '${agentName}' not found in this team`);
  const rawSkill = pick(b.skillRef, cur?.skillRef);
  if (rawSkill !== undefined && rawSkill !== null && typeof rawSkill !== "string") throw new TaskError(400, "skill must be one skill (text) or empty");
  const skillRef = typeof rawSkill === "string" && rawSkill.trim() ? checkSkillRef(db, tenantId, rawSkill.trim(), [agentName], textDir) : null;
  const rawCron = pick(b.cron, cur?.cron);
  if (rawCron !== undefined && rawCron !== null && typeof rawCron !== "string") throw new TaskError(400, "cron must be text or empty");
  const cron = typeof rawCron === "string" && rawCron.trim() ? rawCron.trim().replace(/\s+/g, " ") : null;
  if (cron) { try { parseCron(cron); } catch (e) { throw new TaskError(400, `cron: ${(e as Error).message}`); } }
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new TaskError(400, "enabled must be true or false");
  const enabled = b.enabled === undefined ? !!cur?.enabled && !!cron : b.enabled;
  if (enabled && !cron) throw new TaskError(400, "set a cron schedule before enabling the task");
  const mode = pick(b.mode, cur?.mode) ?? "simulated";
  if (mode !== "simulated" && mode !== "real") throw new TaskError(400, "mode must be simulated or real");
  const rawRepo = pick(b.repo, cur?.repo);
  if (rawRepo !== undefined && rawRepo !== null && typeof rawRepo !== "string") throw new TaskError(400, "repo must be text or empty");
  const repo = typeof rawRepo === "string" && rawRepo.trim() ? rawRepo.trim() : null;
  if (repo) { const d = checkTeamRepo(db, tenantId, repo); if (d) throw new TaskError(400, d); }
  const rawIns = pick(b.instructions, cur?.instructions);
  if (rawIns !== undefined && rawIns !== null && typeof rawIns !== "string") throw new TaskError(400, "instructions must be text");
  const instructions = typeof rawIns === "string" && rawIns.trim() ? rawIns.replace(/\r\n/g, "\n").trim() : null;
  if (instructions && instructions.length > TASK_INSTRUCTIONS_MAX) throw new TaskError(400, `instructions must be at most ${TASK_INSTRUCTIONS_MAX} characters`);
  return { name, agent: agentName, skillRef, cron, enabled, mode: mode as "simulated" | "real", repo, instructions };
}

const byName = (db: DB, tenantId: number, name: string) => db.prepare("SELECT id FROM tasks WHERE tenant_id = ? AND name = ? AND deleted_at IS NULL").get(tenantId, name) as { id: number } | undefined;

export function createTask(db: DB, u: AgentUser, b: Input | null, o: { now?: number; textDir?: string } = {}): Task {
  const now = o.now ?? Date.now();
  const v = validate(db, u.tenantId, b ?? {}, null, o.textDir);
  if (byName(db, u.tenantId, v.name)) throw new TaskError(409, `a task named '${v.name}' already exists in this team`);
  const r = db.prepare("INSERT INTO tasks (tenant_id, name, agent, skill_ref, cron, enabled, mode, repo, instructions, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, v.name, v.agent, v.skillRef, v.cron, v.enabled ? 1 : 0, v.mode, v.repo, v.instructions, u.id, now, now);
  return getTask(db, u.tenantId, Number(r.lastInsertRowid))!;
}

export function updateTask(db: DB, u: AgentUser, id: number, b: Input | null, o: { now?: number; textDir?: string } = {}): Task {
  const t = getTask(db, u.tenantId, id);
  if (!t) throw new TaskError(404, "task not found");
  if (!canEditTask(u, t, db)) throw new TaskError(403, `${DENY} edit it`);
  const v = validate(db, u.tenantId, b ?? {}, t, o.textDir);
  const other = byName(db, u.tenantId, v.name);
  if (other && other.id !== t.id) throw new TaskError(409, `a task named '${v.name}' already exists in this team`);
  db.prepare("UPDATE tasks SET name = ?, agent = ?, skill_ref = ?, cron = ?, enabled = ?, mode = ?, repo = ?, instructions = ?, updated_at = ? WHERE id = ?")
    .run(v.name, v.agent, v.skillRef, v.cron, v.enabled ? 1 : 0, v.mode, v.repo, v.instructions, o.now ?? Date.now(), t.id);
  return getTask(db, u.tenantId, t.id)!;
}

/** Soft delete (row kept, name freed; runs keep their labels). */
export function deleteTask(db: DB, u: AgentUser, id: number, now = Date.now()): void {
  const t = getTask(db, u.tenantId, id);
  if (!t) throw new TaskError(404, "task not found");
  if (!canEditTask(u, t, db)) throw new TaskError(403, `${DENY} delete it`);
  db.prepare("UPDATE tasks SET name = name || '~' || id, enabled = 0, deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?").run(now, u.id, now, t.id);
}
