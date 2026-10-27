// SOP skills: team-scoped storage, permissions, content hashes (including composed skills
// and team agents), approvals and audit. No YAML and no dependency on the workflow runner.
// Visibility: a skill belongs to one team; members, leads and the designated lead see their
// own team's skills only; system admins see every team. Every query is filtered by tenant
// here (server side), so ids from params can't reach another team's rows.
import { createHash } from "node:crypto";
import type { DB } from "../db";
import { getAgent } from "../agents";
import { designatedLead, isSystemAdmin } from "../collab";
import { canonical, MAX_BODY_BYTES, MAX_DEPTH, validatePlan, type Plan } from "./plan";
import { sections } from "./sections";

export type Actor = { id: number; email: string; role: "admin" | "team_lead" | "member"; tenantId: number; name?: string };
export type Skill = {
  id: number; tenantId: number; name: string; version: number; description: string; kind: "sop" | "master"; body: string; plan: Plan;
  contentHash: string; builtin: boolean; createdBy: number | null; updatedBy: number | null; createdAt: number; updatedAt: number;
};
export class SkillError extends Error { constructor(public status: number, public errors: string[]) { super(errors.join("; ")); } }

type Row = { id: number; tenant_id: number; name: string; version: number; description: string; kind: "sop" | "master"; body: string; plan_json: string; content_hash: string; builtin: number; created_by: number | null; updated_by: number | null; created_at: number; updated_at: number };
const fromRow = (r: Row): Skill => ({ id: r.id, tenantId: r.tenant_id, name: r.name, version: r.version, description: r.description, kind: r.kind, body: r.body, plan: JSON.parse(r.plan_json), contentHash: r.content_hash, builtin: !!r.builtin, createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at, updatedAt: r.updated_at });

export const NAME = /^[a-z][a-z0-9-]{0,62}$/;
export const MASTER = "workflow";

/** sha256 of the skill's own content (canonical JSON of description, kind, body and plan). */
export const ownHash = (s: Pick<Skill, "description" | "kind" | "body" | "plan">) =>
  createHash("sha256").update(canonical({ description: s.description, kind: s.kind, body: s.body.replace(/\r\n/g, "\n"), plan: s.plan })).digest("hex");

export function audit(db: DB, u: Pick<Actor, "id" | "email" | "tenantId"> | null, action: string, skillId: number | null, detail = "", tenantId?: number | null, now = Date.now()) {
  db.prepare("INSERT INTO skill_audit (tenant_id, actor_id, actor_email, action, skill_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(tenantId ?? u?.tenantId ?? null, u?.id ?? null, u?.email ?? "system", action, skillId, detail.slice(0, 1000), now);
}

/** The built-in master skill: a skill like any other (declared inputs, structured output) whose plan composes skills. */
export function masterPlan(): Plan {
  return {
    inputs: { goal: { type: "string", required: true, description: "What the composition should achieve" } },
    steps: [
      { id: "start", name: "Record the goal", action: "simulate", with: { goal: "{{goal}}" }, handoffs: [{ from: "inputs.goal", to: "goal" }], on_failure: "stop", outputs: { goal: "result.goal" }, secrets: [], retries: 0 },
      { id: "verify", name: "Verify the composition finished", action: "simulate", with: { checked: "{{goal}}" }, handoffs: [{ from: "steps.start.outputs.goal", to: "goal" }], on_failure: "stop", outputs: { status: "result.checked" }, secrets: [], retries: 0 },
    ],
    outputs: { goal: "steps.start.outputs.goal", status: "steps.verify.status" },
  } as Plan;
}
const MASTER_BODY = "# Workflow (master skill)\n\nComposes other team skills with `call_skill` steps. Copy it, add one `call_skill` step per skill, map inputs with handoffs, guard steps with `when` conditions and keep the final verification step.\n";

/** Creates the per-team master skill 'workflow' if missing (idempotent). */
export function ensureMaster(db: DB, tenantId: number, now = Date.now()): void {
  if (db.prepare("SELECT 1 FROM skills WHERE tenant_id = ? AND name = ?").get(tenantId, MASTER)) return;
  const plan = validatePlan(masterPlan());
  if (!plan.ok) throw new Error(`master plan invalid: ${plan.errors.join("; ")}`);
  const s = { description: "Master skill: composes other skills via call_skill steps (input mapping, conditions, cycle detection, depth cap).", kind: "master" as const, body: MASTER_BODY, plan: plan.plan };
  const r = db.prepare("INSERT OR IGNORE INTO skills (tenant_id, name, version, description, kind, body, plan_json, content_hash, builtin, created_at, updated_at) VALUES (?, ?, 1, ?, 'master', ?, ?, ?, 1, ?, ?)")
    .run(tenantId, MASTER, s.description, s.body, JSON.stringify(s.plan), ownHash(s), now, now);
  if (r.changes) db.prepare("INSERT INTO skill_versions (skill_id, version, description, body, plan_json, content_hash, saved_at, note) VALUES (?, 1, ?, ?, ?, ?, ?, 'built-in')")
    .run(Number(r.lastInsertRowid), s.description, s.body, JSON.stringify(s.plan), ownHash(s), now);
}

/** Team filter for queries: null for system admins (all teams). */
const scope = (u: Pick<Actor, "role" | "tenantId">) => (isSystemAdmin(u) ? null : u.tenantId);

export function listSkills(db: DB, u: Actor): Skill[] {
  ensureMaster(db, u.tenantId);
  const t = scope(u);
  const rows = (t === null ? db.prepare("SELECT * FROM skills ORDER BY tenant_id, name").all() : db.prepare("SELECT * FROM skills WHERE tenant_id = ? ORDER BY name").all(t)) as Row[];
  return rows.map(fromRow);
}

/** A skill by id, visible to u (own team; admins any team). null otherwise (404, never 403, so ids can't be probed). */
export function getSkill(db: DB, u: Pick<Actor, "role" | "tenantId">, id: number): Skill | null {
  if (!Number.isInteger(id) || id <= 0) return null;
  const t = scope(u);
  const r = (t === null ? db.prepare("SELECT * FROM skills WHERE id = ?").get(id) : db.prepare("SELECT * FROM skills WHERE id = ? AND tenant_id = ?").get(id, t)) as Row | undefined;
  return r ? fromRow(r) : null;
}
export function skillByName(db: DB, tenantId: number, name: string): Skill | null {
  const r = db.prepare("SELECT * FROM skills WHERE tenant_id = ? AND name = ?").get(tenantId, name) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** Edit: the creator, the team's team leads (designated lead included) and system admins. Built-ins: leads and admins. */
export function canEdit(db: DB, u: Actor, s: Skill): boolean {
  if (isSystemAdmin(u)) return true;
  if (u.tenantId !== s.tenantId) return false;
  if (u.role === "team_lead" || designatedLead(db, s.tenantId)?.id === u.id) return true;
  return !s.builtin && s.createdBy === u.id;
}

/** Composition graph: call_skill targets resolved in the skill's team. Throws on cycles, depth over MAX_DEPTH or unknown skills. */
export function composed(db: DB, tenantId: number, plan: Plan, selfName: string, path: string[] = [selfName]): Map<string, Skill> {
  const out = new Map<string, Skill>();
  if (path.length > MAX_DEPTH + 1) throw new SkillError(400, [`composition is nested deeper than ${MAX_DEPTH} levels: ${path.join(" -> ")}`]);
  for (const st of plan.steps) {
    if (st.action !== "call_skill" || !st.skill) continue;
    if (path.includes(st.skill)) throw new SkillError(400, [`skill composition cycle: ${[...path, st.skill].join(" -> ")}`]);
    const child = skillByName(db, tenantId, st.skill);
    if (!child) throw new SkillError(400, [`step '${st.id}': unknown skill '${st.skill}' in this team`]);
    out.set(child.name, child);
    for (const [k, v] of composed(db, tenantId, child.plan, child.name, [...path, child.name])) out.set(k, v);
  }
  return out;
}

export function agentRefs(plan: Plan): string[] {
  return [...new Set(plan.steps.filter((s) => s.action === "agent" && typeof s.with.agent === "string").map((s) => String(s.with.agent)))].sort();
}

/**
 * Effective (approval) hash: the skill's own hash plus every composed skill's own hash and every
 * referenced team agent's hash (directly or through composition). Any change anywhere needs re-approval.
 */
export function effectiveHash(db: DB, s: Skill): { hash: string; parts: string[]; errors: string[] } {
  const errors: string[] = [];
  let kids = new Map<string, Skill>();
  try { kids = composed(db, s.tenantId, s.plan, s.name); } catch (e) { errors.push(...(e instanceof SkillError ? e.errors : [String(e)])); }
  const agents = new Set(agentRefs(s.plan));
  for (const k of kids.values()) for (const a of agentRefs(k.plan)) agents.add(a);
  const parts = [`skill:${s.name}:${s.contentHash}`, ...[...kids.values()].sort((a, b) => a.name.localeCompare(b.name)).map((k) => `skill:${k.name}:${k.contentHash}`)];
  for (const a of [...agents].sort()) {
    const ag = getAgent(db, s.tenantId, a);
    if (!ag) errors.push(`unknown agent '${a}'; create it on the Agents page`);
    parts.push(`agent:${a}:${ag?.contentHash ?? "missing"}`);
  }
  return { hash: createHash("sha256").update(parts.join("\n")).digest("hex"), parts, errors };
}

/** A tiny skill (body only): a minimal explicit plan with one agent step using the body as its prompt. */
export function derivePlan(): Plan {
  return {
    inputs: { prompt: { type: "string", required: false, default: "", description: "Extra instructions for this run" } },
    steps: [{ id: "run", name: "Follow the SOP", action: "agent", with: { prompt: "Follow the SOP in .cobra/SOP.md.\n{{prompt}}", repo: "{{repo}}", mode: "{{mode}}" },
      handoffs: [{ from: "inputs.prompt", to: "prompt" }, { from: "run.repo", to: "repo" }, { from: "run.mode", to: "mode" }], on_failure: "stop", outputs: { summary: "result.summary" }, secrets: [], retries: 0 }],
    outputs: { status: "steps.run.status", summary: "steps.run.outputs.summary" },
  };
}

export type SaveInput = { name?: unknown; description?: unknown; body?: unknown; plan?: unknown; kind?: unknown };

function prepare(db: DB, tenantId: number, b: SaveInput, current?: Skill) {
  const errors: string[] = [];
  const name = typeof b.name === "string" ? b.name.trim().toLowerCase() : current?.name ?? "";
  if (!NAME.test(name)) errors.push("name: lowercase letters, digits and '-', starting with a letter (max 63)");
  const description = typeof b.description === "string" ? b.description.trim() : current?.description ?? "";
  const body = typeof b.body === "string" ? b.body.replace(/\r\n/g, "\n") : current?.body ?? "";
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) errors.push("body: larger than the 4 MB technical limit");
  const kind = b.kind === "master" ? "master" : b.kind === "sop" || b.kind === undefined ? (current?.kind ?? "sop") : null;
  if (!kind) errors.push("kind must be sop or master");
  const noPlan = b.plan === undefined || b.plan === null || (typeof b.plan === "string" && !b.plan.trim());
  if (noPlan && !current && !body.trim()) errors.push("give an SOP body, a plan or both");
  const v = noPlan ? (current ? { ok: true as const, plan: current.plan } : validatePlan(derivePlan())) : validatePlan(b.plan);
  if (!v.ok) errors.push(...v.errors);
  if (errors.length) throw new SkillError(400, errors);
  const plan = (v as { plan: Plan }).plan;
  const anchors = new Set(sections(body).map((s) => s.anchor));
  plan.steps.forEach((s, i) => { if (s.section && !anchors.has(s.section)) errors.push(`steps[${i}].section: no heading with anchor '${s.section}' in the SOP body`); });
  if (errors.length) throw new SkillError(400, errors);
  composed(db, tenantId, plan, name);
  return { name, description, body, kind: kind!, plan };
}

/** Creates a skill in the actor's team. Any member or team lead can create. Returns the new skill. */
export function createSkill(db: DB, u: Actor, b: SaveInput, now = Date.now()): Skill {
  const p = prepare(db, u.tenantId, b);
  if (p.name === MASTER) throw new SkillError(409, ["'workflow' is the built-in master skill; pick another name"]);
  if (skillByName(db, u.tenantId, p.name)) throw new SkillError(409, [`a skill named '${p.name}' already exists in your team`]);
  const hash = ownHash(p);
  const r = db.prepare("INSERT INTO skills (tenant_id, name, version, description, kind, body, plan_json, content_hash, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, p.name, p.description, p.kind, p.body, JSON.stringify(p.plan), hash, u.id, u.id, now, now);
  const id = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO skill_versions (skill_id, version, description, body, plan_json, content_hash, saved_by, saved_at, note) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'created')").run(id, p.description, p.body, JSON.stringify(p.plan), hash, u.id, now);
  audit(db, u, "skill_create", id, `${p.name} v1 @${hash.slice(0, 12)}`);
  return getSkill(db, { role: "admin", tenantId: u.tenantId }, id)!;
}

/** Saves a new version (only when content changed). Name changes aren't allowed (runs/approvals key on it). */
export function updateSkill(db: DB, u: Actor, id: number, b: SaveInput, note = "edited", now = Date.now()): { skill: Skill; changed: boolean } {
  const cur = getSkill(db, u, id);
  if (!cur) throw new SkillError(404, ["skill not found"]);
  if (!canEdit(db, u, cur)) throw new SkillError(403, ["you can't edit this skill (its creator, team leads, the designated lead and system admins can)"]);
  if (typeof b.name === "string" && b.name.trim().toLowerCase() !== cur.name) throw new SkillError(400, ["skills can't be renamed; create a new one"]);
  const p = prepare(db, cur.tenantId, { ...b, name: cur.name }, cur);
  const hash = ownHash(p);
  if (hash === cur.contentHash) return { skill: cur, changed: false };
  const v = cur.version + 1;
  db.prepare("UPDATE skills SET version = ?, description = ?, kind = ?, body = ?, plan_json = ?, content_hash = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .run(v, p.description, p.kind, p.body, JSON.stringify(p.plan), hash, u.id, now, id);
  db.prepare("INSERT INTO skill_versions (skill_id, version, description, body, plan_json, content_hash, saved_by, saved_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, v, p.description, p.body, JSON.stringify(p.plan), hash, u.id, now, note.slice(0, 200));
  audit(db, u, "skill_update", id, `${cur.name} v${v} @${hash.slice(0, 12)} (${note})`, cur.tenantId);
  return { skill: getSkill(db, u, id)!, changed: true };
}

export function versions(db: DB, skillId: number) {
  return db.prepare("SELECT v.version, v.content_hash AS hash, v.saved_at AS savedAt, v.note, u.email AS savedBy FROM skill_versions v LEFT JOIN users u ON u.id = v.saved_by WHERE v.skill_id = ? ORDER BY v.version DESC LIMIT 50").all(skillId) as Array<{ version: number; hash: string; savedAt: number; note: string | null; savedBy: string | null }>;
}

// ---- Approvals (same rules as workflows: system admins and the team's leads approve; the author's own
// approval counts only for a system admin; one approval; any reject blocks; tied to the effective hash).
export type ApprovalState = { status: "approved" | "pending" | "rejected"; hash: string; reason: string; decisions: Array<{ email: string; role: string; decision: string; comment: string; createdAt: number }> };

export const canApprove = (u: Actor, s: Skill) => isSystemAdmin(u) || (u.tenantId === s.tenantId && u.role === "team_lead");

export function approvalState(db: DB, s: Skill): ApprovalState {
  const { hash, errors } = effectiveHash(db, s);
  const rows = db.prepare(`SELECT a.approver_id AS id, u.email, u.role, u.tenant_id AS tenantId, a.decision, a.comment, a.created_at AS createdAt FROM skill_approvals a JOIN users u ON u.id = a.approver_id
    WHERE a.skill_id = ? AND a.content_hash = ? AND a.id = (SELECT MAX(b.id) FROM skill_approvals b WHERE b.skill_id = a.skill_id AND b.content_hash = a.content_hash AND b.approver_id = a.approver_id) ORDER BY a.created_at`).all(s.id, hash) as Array<{ id: number; email: string; role: Actor["role"]; tenantId: number; decision: string; comment: string; createdAt: number }>;
  const valid = rows.filter((r) => canApprove({ id: r.id, email: r.email, role: r.role, tenantId: r.tenantId }, s));
  const decisions = valid.map(({ email, role, decision, comment, createdAt }) => ({ email, role, decision, comment, createdAt }));
  if (errors.length) return { status: "pending", hash, reason: errors[0], decisions };
  if (valid.some((r) => r.decision === "reject")) return { status: "rejected", hash, reason: "rejected by an approver", decisions };
  const counted = valid.filter((r) => r.decision === "approve" && (r.id !== s.updatedBy || r.role === "admin"));
  return counted.length >= 1 ? { status: "approved", hash, reason: `${counted.length}/1 approvals`, decisions } : { status: "pending", hash, reason: "needs 1 approval from a team lead or system admin (not the author)", decisions };
}

export function decide(db: DB, u: Actor, s: Skill, decision: unknown, comment: unknown, now = Date.now()): ApprovalState {
  if (decision !== "approve" && decision !== "reject") throw new SkillError(400, ["decision must be approve or reject"]);
  if (!canApprove(u, s)) throw new SkillError(403, ["only the team's leads and system admins can approve skills"]);
  const { hash } = effectiveHash(db, s);
  db.prepare("INSERT INTO skill_approvals (tenant_id, skill_id, content_hash, approver_id, decision, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(s.tenantId, s.id, hash, u.id, decision, typeof comment === "string" ? comment.slice(0, 2000) : "", now);
  audit(db, u, `skill_${decision}`, s.id, `@${hash.slice(0, 12)}`, s.tenantId);
  return approvalState(db, s);
}
