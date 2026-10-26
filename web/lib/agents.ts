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

export const AGENT_ENGINES = ["claude-code", "codex"] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];
export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;

export type TeamAgent = {
  id: number; name: string; engine: AgentEngine; model: string | null; description: string | null; prompt: string; defaultRepo: string | null;
  contentHash: string; createdBy: number | null; createdByEmail: string | null; createdAt: number; updatedAt: number;
};
export type AgentUser = { id: number; role: string; tenantId: number };

export const AGENT_PROMPT_MAX = 20000;
export const AGENT_DESCRIPTION_MAX = 500;

export class AgentError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Without a model the hash is unchanged from before Job 23, so existing approvals stay valid. */
export const agentHash = (engine: string, prompt: string, model?: string | null) =>
  createHash("sha256").update(model ? `${engine}\n${prompt}\nmodel:${model}` : `${engine}\n${prompt}`).digest("hex");

const COLS = `a.id, a.name, a.engine, a.model, a.description, a.prompt, a.default_repo AS defaultRepo, a.content_hash AS contentHash, a.created_by AS createdBy,
  u.email AS createdByEmail, a.created_at AS createdAt, a.updated_at AS updatedAt`;
// node:sqlite rows have a null prototype; spread into plain objects for client components.
const plain = (r: unknown) => ({ ...(r as TeamAgent) });

export function listAgents(db: DB, tenantId: number): TeamAgent[] {
  return db.prepare(`SELECT ${COLS} FROM team_agents a LEFT JOIN users u ON u.id = a.created_by WHERE a.tenant_id = ? ORDER BY a.name`).all(tenantId).map(plain);
}

export function getAgent(db: DB, tenantId: number, name: string): TeamAgent | null {
  const r = db.prepare(`SELECT ${COLS} FROM team_agents a LEFT JOIN users u ON u.id = a.created_by WHERE a.tenant_id = ? AND a.name = ?`).get(tenantId, name);
  return r ? plain(r) : null;
}

/** Creator, team leads and admins (always within the agent's own team). */
export function canEditAgent(u: AgentUser, a: Pick<TeamAgent, "createdBy">): boolean {
  return u.role === "admin" || u.role === "team_lead" || (a.createdBy !== null && a.createdBy === u.id);
}

type Input = { name?: unknown; engine?: unknown; model?: unknown; description?: unknown; prompt?: unknown; defaultRepo?: unknown };
function validate(db: DB, tenantId: number, b: Input, partial: TeamAgent | null) {
  const name = b.name === undefined && partial ? partial.name : typeof b.name === "string" ? b.name.trim() : "";
  if (!AGENT_NAME_RE.test(name)) throw new AgentError(400, "name must be a slug: lowercase letters, digits and '-', starting with a letter (max 63)");
  const engine = (b.engine === undefined && partial ? partial.engine : b.engine) as AgentEngine;
  if (!AGENT_ENGINES.includes(engine)) throw new AgentError(400, `engine must be one of ${AGENT_ENGINES.join(", ")}`);
  // Changing the engine without naming a model resets it to the default (old model may not exist there).
  const rawModel = b.model !== undefined ? b.model : partial && engine === partial.engine ? partial.model : null;
  let model: string | null;
  try { model = checkModel(engine, rawModel); } catch (e) { throw new AgentError(400, (e as Error).message); }
  const prompt = b.prompt === undefined && partial ? partial.prompt : typeof b.prompt === "string" ? b.prompt.replace(/\r\n/g, "\n").trim() : "";
  if (!prompt) throw new AgentError(400, "prompt is required");
  if (prompt.length > AGENT_PROMPT_MAX) throw new AgentError(400, `prompt must be at most ${AGENT_PROMPT_MAX} characters`);
  if (b.description !== undefined && b.description !== null && typeof b.description !== "string") throw new AgentError(400, "description must be a string or null");
  const rawDesc = b.description === undefined && partial ? partial.description : typeof b.description === "string" ? b.description.replace(/\r\n/g, "\n").trim() : "";
  const description = rawDesc ? rawDesc : null;
  if (description && description.length > AGENT_DESCRIPTION_MAX) throw new AgentError(400, `description must be at most ${AGENT_DESCRIPTION_MAX} characters`);
  let defaultRepo: string | null = b.defaultRepo === undefined && partial ? partial.defaultRepo : typeof b.defaultRepo === "string" && b.defaultRepo.trim() ? b.defaultRepo.trim() : null;
  if (b.defaultRepo !== undefined && b.defaultRepo !== null && typeof b.defaultRepo !== "string") throw new AgentError(400, "defaultRepo must be a string or null");
  if (defaultRepo) { const d = checkTeamRepo(db, tenantId, defaultRepo); if (d) throw new AgentError(400, d); }
  else defaultRepo = null;
  return { name, engine, model, description, prompt, defaultRepo };
}

export function createAgent(db: DB, u: AgentUser, b: Input | null, now = Date.now()): TeamAgent {
  const v = validate(db, u.tenantId, b ?? {}, null);
  if (getAgent(db, u.tenantId, v.name)) throw new AgentError(409, `an agent named '${v.name}' already exists in this team`);
  db.prepare("INSERT INTO team_agents (tenant_id, name, engine, model, description, prompt, default_repo, content_hash, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, v.name, v.engine, v.model, v.description, v.prompt, v.defaultRepo, agentHash(v.engine, v.prompt, v.model), u.id, now, now);
  return getAgent(db, u.tenantId, v.name)!;
}

export function updateAgent(db: DB, u: AgentUser, name: string, b: Input | null, now = Date.now()): TeamAgent {
  const a = getAgent(db, u.tenantId, name);
  if (!a) throw new AgentError(404, `agent '${name}' not found`);
  if (!canEditAgent(u, a)) throw new AgentError(403, "only the agent's creator, team leads and admins can edit it");
  const v = validate(db, u.tenantId, b ?? {}, a);
  if (v.name !== a.name && getAgent(db, u.tenantId, v.name)) throw new AgentError(409, `an agent named '${v.name}' already exists in this team`);
  db.prepare("UPDATE team_agents SET name = ?, engine = ?, model = ?, description = ?, prompt = ?, default_repo = ?, content_hash = ?, updated_at = ? WHERE id = ?")
    .run(v.name, v.engine, v.model, v.description, v.prompt, v.defaultRepo, agentHash(v.engine, v.prompt, v.model), now, a.id);
  return getAgent(db, u.tenantId, v.name)!;
}

export function deleteAgent(db: DB, u: AgentUser, name: string): void {
  const a = getAgent(db, u.tenantId, name);
  if (!a) throw new AgentError(404, `agent '${name}' not found`);
  if (!canEditAgent(u, a)) throw new AgentError(403, "only the agent's creator, team leads and admins can delete it");
  db.prepare("DELETE FROM team_agents WHERE id = ?").run(a.id);
}

/** The prompt an agent runs with: its own prompt plus optional extra instructions. */
export function finalPrompt(agentPrompt: string, extra?: unknown): string {
  const x = typeof extra === "string" ? extra.trim() : "";
  return x ? `${agentPrompt}\n\nAdditional instructions:\n${x}` : agentPrompt;
}
