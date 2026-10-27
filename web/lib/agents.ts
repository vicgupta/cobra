// Team agents: a named engine + prompt that any team member can create and run,
// directly or from workflow steps (`uses: agent` with `with: { agent: <name> }`).
// Visible to the whole team, never to other teams. Only the creator, team leads
// and admins may edit or delete. content_hash = sha256(engine + "\n" + prompt [+ "\nmodel:" + model])
// is the agent's prompt version (the optional description is NOT hashed: editing it keeps approvals); workflows that reference an agent fold it into
// their effective approval hash (lib/workflows/store.ts withAgents).
import { createHash } from "node:crypto";
import type { DB } from "./db";
import { checkTeamRepo } from "./repos";
import { checkModel } from "./agent-models";

import { existsSync } from "node:fs";
import path from "node:path";
import { ENGINES, type Engine } from "./engines";
import { parseCron } from "./cron";

export const AGENT_ENGINES = ENGINES;
export type AgentEngine = Engine;
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;

export type TeamAgent = {
  id: number; name: string; engine: AgentEngine; model: string | null; description: string | null; prompt: string; defaultRepo: string | null;
  /** Prompt XOR skill: null = prompt agent; "sop:<skill id>" or "text:<file name>" = runs that one skill. */
  skillRef: string | null;
  /** Optional 5-field cron (America/New_York); runs only while cronEnabled. cronMode: simulated (default) or real. */
  cron: string | null; cronEnabled: boolean; cronMode: "simulated" | "real"; cronLastFire: number | null;
  contentHash: string; createdBy: number | null; createdByEmail: string | null; createdAt: number; updatedAt: number;
};
export type AgentUser = { id: number; role: string; tenantId: number };

export const AGENT_PROMPT_MAX = 20000;
export const AGENT_DESCRIPTION_MAX = 500;

export class AgentError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Without a model the hash is unchanged from before Job 23, so existing approvals stay valid. */
/** A skill reference is hashed only when set, so prompt agents keep their existing hashes. */
export const agentHash = (engine: string, prompt: string, model?: string | null, skillRef?: string | null) =>
  createHash("sha256").update((model ? `${engine}\n${prompt}\nmodel:${model}` : `${engine}\n${prompt}`) + (skillRef ? `\nskill:${skillRef}` : "")).digest("hex");

const COLS = `a.id, a.name, a.engine, a.model, a.description, a.prompt, a.default_repo AS defaultRepo, a.skill_ref AS skillRef,
  a.cron, a.cron_enabled AS cronEnabled, a.cron_mode AS cronMode, a.cron_last_fire AS cronLastFire, a.content_hash AS contentHash, a.created_by AS createdBy,
  u.email AS createdByEmail, a.created_at AS createdAt, a.updated_at AS updatedAt`;
// node:sqlite rows have a null prototype; spread into plain objects for client components.
const plain = (r: unknown): TeamAgent => { const a = { ...(r as TeamAgent) }; a.cronEnabled = !!a.cronEnabled; a.cronMode = a.cronMode === "real" ? "real" : "simulated"; return a; };

export function listAgents(db: DB, tenantId: number): TeamAgent[] {
  return db.prepare(`SELECT ${COLS} FROM team_agents a LEFT JOIN users u ON u.id = a.created_by WHERE a.tenant_id = ? AND a.deleted_at IS NULL ORDER BY a.name`).all(tenantId).map(plain);
}

export function getAgent(db: DB, tenantId: number, name: string): TeamAgent | null {
  const r = db.prepare(`SELECT ${COLS} FROM team_agents a LEFT JOIN users u ON u.id = a.created_by WHERE a.tenant_id = ? AND a.name = ? AND a.deleted_at IS NULL`).get(tenantId, name);
  return r ? plain(r) : null;
}

/** The team's designated lead (tenants.designated_lead_user_id), who may be a plain member. */
export const isDesignatedLead = (db: DB, u: AgentUser) =>
  (db.prepare("SELECT designated_lead_user_id AS d FROM tenants WHERE id = ?").get(u.tenantId) as { d: number | null } | undefined)?.d === u.id;
/** Edit/delete: the creator, team leads, the team's designated lead and admins (same rule as team repos), within the team.
 *  Pass `db` to include the designated lead; everyone else in the team can only run the agent. */
export function canEditAgent(u: AgentUser, a: Pick<TeamAgent, "createdBy">, db?: DB): boolean {
  return u.role === "admin" || u.role === "team_lead" || (a.createdBy !== null && a.createdBy === u.id) || (!!db && isDesignatedLead(db, u));
}
const DENY = "only the agent's creator, team leads, the designated lead and admins can";

type Input = { name?: unknown; engine?: unknown; model?: unknown; description?: unknown; prompt?: unknown; defaultRepo?: unknown;
  kind?: unknown; skillRef?: unknown; cron?: unknown; cronEnabled?: unknown; cronMode?: unknown };

export const TEXT_SKILL_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const textSkillsDir = () => path.join(process.cwd(), "skills");
type SkillRow = { id: number; name: string; plan_json: string };
const planOf = (r: SkillRow) => { try { return JSON.parse(r.plan_json) as { steps?: Array<{ action?: string; skill?: string; with?: Record<string, unknown> }> }; } catch { return { steps: [] }; } };

/**
 * Loop guard: the agents a SOP skill calls in `agent` steps, directly or through call_skill (cycle-safe).
 * Plain SQL here (not lib/skills/store) so this module has no import cycle with the skills code.
 */
export function skillAgentRefs(db: DB, tenantId: number, skillId: number): Set<string> {
  const out = new Set<string>(), seen = new Set<string>();
  const walk = (r: SkillRow | undefined) => {
    if (!r || seen.has(r.name)) return;
    seen.add(r.name);
    for (const st of planOf(r).steps ?? []) {
      if (st.action === "agent" && typeof st.with?.agent === "string" && st.with.agent) out.add(st.with.agent);
      if (st.action === "call_skill" && st.skill) walk(db.prepare("SELECT id, name, plan_json FROM skills WHERE tenant_id = ? AND name = ?").get(tenantId, st.skill) as SkillRow | undefined);
    }
  };
  walk(db.prepare("SELECT id, name, plan_json FROM skills WHERE tenant_id = ? AND id = ?").get(tenantId, skillId) as SkillRow | undefined);
  return out;
}

/** "sop:<id>" (a team SOP skill) or "text:<file>" (web/skills/<file>.md); errors are AgentError 400. */
export function checkSkillRef(db: DB, tenantId: number, ref: string, agentNames: string[], textDir = textSkillsDir()): string {
  const m = /^(sop|text):(.+)$/.exec(ref);
  if (!m) throw new AgentError(400, "skill must be sop:<id> or text:<file name>");
  if (m[1] === "text") {
    if (!TEXT_SKILL_RE.test(m[2]) || !existsSync(path.join(textDir, `${m[2]}.md`))) throw new AgentError(400, `text skill '${m[2]}' not found`);
    return `text:${m[2]}`;
  }
  const id = Number(m[2]);
  const row = Number.isInteger(id) && id > 0 ? db.prepare("SELECT id, name FROM skills WHERE tenant_id = ? AND id = ?").get(tenantId, id) as { id: number; name: string } | undefined : undefined;
  if (!row) throw new AgentError(400, "skill not found in this team");
  const refs = skillAgentRefs(db, tenantId, id);
  const hit = agentNames.find((n) => refs.has(n));
  if (hit) throw new AgentError(400, `loop: skill '${row.name}' (directly or via call_skill) has an agent step that calls agent '${hit}'; pick another skill`);
  return `sop:${id}`;
}
function validate(db: DB, tenantId: number, b: Input, partial: TeamAgent | null) {
  const name = b.name === undefined && partial ? partial.name : typeof b.name === "string" ? b.name.trim().toLowerCase() : "";
  if (!AGENT_NAME_RE.test(name)) throw new AgentError(400, "name must be a slug: lowercase letters, digits and '-', starting with a letter (max 63)");
  const engine = (b.engine === undefined && partial ? partial.engine : b.engine) as AgentEngine;
  if (!AGENT_ENGINES.includes(engine)) throw new AgentError(400, `engine must be one of ${AGENT_ENGINES.join(", ")}`);
  // Changing the engine without naming a model resets it to the default (old model may not exist there).
  const rawModel = b.model !== undefined ? b.model : partial && engine === partial.engine ? partial.model : null;
  let model: string | null;
  try { model = checkModel(engine, rawModel, process.env); } catch (e) { throw new AgentError(400, (e as Error).message); }
  // Prompt XOR skill: kind "skill" needs skillRef and clears the prompt; kind "prompt" needs a prompt and clears the skill.
  if (b.kind !== undefined && b.kind !== "prompt" && b.kind !== "skill") throw new AgentError(400, "kind must be prompt or skill");
  if (b.skillRef !== undefined && b.skillRef !== null && typeof b.skillRef !== "string") throw new AgentError(400, "skillRef must be a string or null");
  const kind = b.kind ?? (b.skillRef ? "skill" : b.prompt !== undefined ? "prompt" : partial?.skillRef ? "skill" : "prompt");
  const hasPrompt = typeof b.prompt === "string" && b.prompt.trim() !== "";
  if (kind === "skill" && hasPrompt) throw new AgentError(400, "an agent has either a prompt or a skill, not both");
  if (kind === "prompt" && typeof b.skillRef === "string" && b.skillRef) throw new AgentError(400, "an agent has either a prompt or a skill, not both");
  let skillRef: string | null = null;
  if (kind === "skill") {
    const raw = typeof b.skillRef === "string" && b.skillRef.trim() ? b.skillRef.trim() : b.skillRef === undefined && partial?.skillRef ? partial.skillRef : "";
    if (!raw) throw new AgentError(400, "pick a skill for this agent");
    skillRef = checkSkillRef(db, tenantId, raw, [name, ...(partial ? [partial.name] : [])]);
  }
  const prompt = kind === "skill" ? "" : b.prompt === undefined && partial && !partial.skillRef ? partial.prompt : typeof b.prompt === "string" ? b.prompt.replace(/\r\n/g, "\n").trim() : "";
  if (kind === "prompt" && !prompt) throw new AgentError(400, "prompt is required");
  if (prompt.length > AGENT_PROMPT_MAX) throw new AgentError(400, `prompt must be at most ${AGENT_PROMPT_MAX} characters`);
  if (b.description !== undefined && b.description !== null && typeof b.description !== "string") throw new AgentError(400, "description must be a string or null");
  const rawDesc = b.description === undefined && partial ? partial.description : typeof b.description === "string" ? b.description.replace(/\r\n/g, "\n").trim() : "";
  const description = rawDesc ? rawDesc : null;
  if (description && description.length > AGENT_DESCRIPTION_MAX) throw new AgentError(400, `description must be at most ${AGENT_DESCRIPTION_MAX} characters`);
  let defaultRepo: string | null = b.defaultRepo === undefined && partial ? partial.defaultRepo : typeof b.defaultRepo === "string" && b.defaultRepo.trim() ? b.defaultRepo.trim() : null;
  if (b.defaultRepo !== undefined && b.defaultRepo !== null && typeof b.defaultRepo !== "string") throw new AgentError(400, "defaultRepo must be a string or null");
  if (defaultRepo) { const d = checkTeamRepo(db, tenantId, defaultRepo); if (d) throw new AgentError(400, d); }
  else defaultRepo = null;
  // Schedule: optional cron (validated), off unless explicitly enabled; scheduled runs are simulated unless cronMode is real.
  if (b.cron !== undefined && b.cron !== null && typeof b.cron !== "string") throw new AgentError(400, "cron must be a string or null");
  const cronRaw = b.cron === undefined && partial ? partial.cron : typeof b.cron === "string" ? b.cron.trim().replace(/\s+/g, " ") : "";
  const cron = cronRaw ? cronRaw : null;
  if (cron) { try { parseCron(cron); } catch (e) { throw new AgentError(400, `cron: ${(e as Error).message}`); } }
  if (b.cronEnabled !== undefined && typeof b.cronEnabled !== "boolean") throw new AgentError(400, "cronEnabled must be true or false");
  const cronEnabled = b.cronEnabled === undefined ? !!partial?.cronEnabled && !!cron : b.cronEnabled;
  if (cronEnabled && !cron) throw new AgentError(400, "set a cron schedule before enabling it");
  if (b.cronMode !== undefined && b.cronMode !== "simulated" && b.cronMode !== "real") throw new AgentError(400, "cronMode must be simulated or real");
  const cronMode = (b.cronMode ?? partial?.cronMode ?? "simulated") as "simulated" | "real";
  return { name, engine, model, description, prompt, defaultRepo, skillRef, cron, cronEnabled, cronMode };
}

export function createAgent(db: DB, u: AgentUser, b: Input | null, now = Date.now()): TeamAgent {
  const v = validate(db, u.tenantId, b ?? {}, null);
  if (getAgent(db, u.tenantId, v.name)) throw new AgentError(409, `an agent named '${v.name}' already exists in this team`);
  db.prepare("INSERT INTO team_agents (tenant_id, name, engine, model, description, prompt, default_repo, skill_ref, cron, cron_enabled, cron_mode, content_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, v.name, v.engine, v.model, v.description, v.prompt, v.defaultRepo, v.skillRef, v.cron, v.cronEnabled ? 1 : 0, v.cronMode, agentHash(v.engine, v.prompt, v.model, v.skillRef), u.id, now, now);
  return getAgent(db, u.tenantId, v.name)!;
}

export function updateAgent(db: DB, u: AgentUser, name: string, b: Input | null, now = Date.now()): TeamAgent {
  const a = getAgent(db, u.tenantId, name);
  if (!a) throw new AgentError(404, `agent '${name}' not found`);
  if (!canEditAgent(u, a, db)) throw new AgentError(403, `${DENY} edit it`);
  const v = validate(db, u.tenantId, b ?? {}, a);
  if (v.name !== a.name && getAgent(db, u.tenantId, v.name)) throw new AgentError(409, `an agent named '${v.name}' already exists in this team`);
  db.prepare("UPDATE team_agents SET name = ?, engine = ?, model = ?, description = ?, prompt = ?, default_repo = ?, skill_ref = ?, cron = ?, cron_enabled = ?, cron_mode = ?, content_hash = ?, updated_at = ? WHERE id = ?")
    .run(v.name, v.engine, v.model, v.description, v.prompt, v.defaultRepo, v.skillRef, v.cron, v.cronEnabled ? 1 : 0, v.cronMode, agentHash(v.engine, v.prompt, v.model, v.skillRef), now, a.id);
  return getAgent(db, u.tenantId, v.name)!;
}

/** Soft delete: hidden everywhere and the name is freed, but the row (and every run that used it) is kept. */
export function deleteAgent(db: DB, u: AgentUser, name: string, now = Date.now()): void {
  const a = getAgent(db, u.tenantId, name);
  if (!a) throw new AgentError(404, `agent '${name}' not found`);
  if (!canEditAgent(u, a, db)) throw new AgentError(403, `${DENY} delete it`);
  db.prepare("UPDATE team_agents SET name = name || '~' || id, deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?").run(now, u.id, now, a.id);
}

/** The prompt an agent runs with: its own prompt plus optional extra instructions. */
export function finalPrompt(agentPrompt: string, extra?: unknown): string {
  const x = typeof extra === "string" ? extra.trim() : "";
  return x ? `${agentPrompt}\n\nAdditional instructions:\n${x}` : agentPrompt;
}
