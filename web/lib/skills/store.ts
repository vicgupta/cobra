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

/** sha256 of the skill's own content (canonical JSON of description, kind, body and plan). */
export const ownHash = (s: Pick<Skill, "description" | "kind" | "body" | "plan">) =>
  createHash("sha256").update(canonical({ description: s.description, kind: s.kind, body: s.body.replace(/\r\n/g, "\n"), plan: s.plan })).digest("hex");

export function audit(db: DB, u: Pick<Actor, "id" | "email" | "tenantId"> | null, action: string, skillId: number | null, detail = "", tenantId?: number | null, now = Date.now()) {
  db.prepare("INSERT INTO skill_audit (tenant_id, actor_id, actor_email, action, skill_id, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(tenantId ?? u?.tenantId ?? null, u?.id ?? null, u?.email ?? "system", action, skillId, detail.slice(0, 1000), now);
}

/** The starting plan for a new master skill a user creates: declared inputs, structured output, composes skills. Nothing is seeded. */
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
/** Starter text for the "Master skill" option in the new-skill dropdown (users create their own master skills; none is seeded). */
export const MASTER_STARTER_BODY = "# Workflow (master skill)\n\nComposes other team skills with `call_skill` steps. Add one `call_skill` step per skill, map inputs with handoffs, guard steps with `when` conditions and keep the final verification step.\n";

/** Team filter for queries: always the caller's own team (system admins included; skills never cross teams). */
const scope = (u: Pick<Actor, "role" | "tenantId">): number | null => u.tenantId;

export function listSkills(db: DB, u: Actor): Skill[] {
  const t = scope(u);
  const rows = (t === null ? db.prepare("SELECT * FROM skills ORDER BY tenant_id, name").all() : db.prepare("SELECT * FROM skills WHERE tenant_id = ? ORDER BY name").all(t)) as Row[];
  return rows.map(fromRow);
}

/** A skill by id, visible to u (own team only). null otherwise (404, never 403, so ids can't be probed). */
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
  if (u.tenantId !== s.tenantId) return false;
  if (isSystemAdmin(u)) return true;
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

/** "release-notes" -> "Release notes" (how a section anchor reads in an error). */
const pretty = (a: string) => { const t = a.replace(/-\d+$/, "").replace(/-/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

/**
 * The steps of a body-only skill, derived from the plain-text SOP every time it is saved, so the
 * steps can never drift from the headings. Headings at the outermost level become one agent step
 * each, in order (a lone top title with sub-headings is skipped and its sub-headings are used).
 * Fewer than two such headings: one step that follows the whole SOP (derivePlan).
 */
export function planFromBody(body: string): Plan {
  const all = sections(body);
  if (!all.length) return derivePlan();
  let level = Math.min(...all.map((h) => h.level));
  if (all.filter((h) => h.level === level).length === 1) {
    const deeper = all.filter((h) => h.level > level);
    if (deeper.length) level = Math.min(...deeper.map((h) => h.level));
  }
  const picked = all.filter((h) => h.level === level);
  if (picked.length < 2) return derivePlan();
  const used = new Set<string>();
  const steps = picked.map((h, i) => {
    let id = /^[a-z][a-z0-9_-]{0,62}$/.test(h.anchor) ? h.anchor : `step-${i + 1}`;
    if (used.has(id)) id = `step-${i + 1}`;
    used.add(id);
    const title = h.title.replace(/[{}]/g, "").trim() || `Step ${i + 1}`;
    const prev = i > 0 ? [...used][i - 1] : null;
    const handoffs = [{ from: "inputs.prompt", to: "prompt" }, { from: "run.repo", to: "repo" }, { from: "run.mode", to: "mode" }, ...(prev ? [{ from: `steps.${prev}.outputs.summary`, to: "prev" }] : [])];
    const prompt = `Do the "${title}" section of the SOP in .cobra/SOP.md.${prev ? "\nWhat the previous step did: {{prev}}" : ""}\n{{prompt}}`;
    return { id, name: title.slice(0, 500), action: "agent" as const, ...(/^[a-z0-9][a-z0-9-]*$/.test(h.anchor) ? { section: h.anchor } : {}),
      with: { prompt, repo: "{{repo}}", mode: "{{mode}}" }, handoffs, on_failure: "stop" as const, outputs: { summary: "result.summary" }, secrets: [], retries: 0 };
  });
  const last = steps[steps.length - 1].id;
  return { inputs: derivePlan().inputs, steps, outputs: { status: `steps.${last}.status`, summary: `steps.${last}.outputs.summary` } } as Plan;
}

/** True when a stored plan is exactly what the body would produce (so edits re-derive it). */
const isDerived = (s: Skill) => s.kind !== "master" && [planFromBody(s.body), derivePlan()].some((p) => { const v = validatePlan(p); return v.ok && JSON.stringify(v.plan) === JSON.stringify(s.plan); });

export type SaveInput = { name?: unknown; description?: unknown; body?: unknown; plan?: unknown; kind?: unknown };

function prepare(db: DB, tenantId: number, b: SaveInput, current?: Skill, check = false) {
  const errors: string[] = [];
  const name = typeof b.name === "string" ? b.name.trim().toLowerCase() : current?.name ?? "";
  if (!(check && !name) && !NAME.test(name)) errors.push("Name: use lowercase letters, numbers and dashes, starting with a letter (63 characters at most).");
  const description = typeof b.description === "string" ? b.description.trim() : current?.description ?? "";
  const body = typeof b.body === "string" ? b.body.replace(/\r\n/g, "\n") : current?.body ?? "";
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) errors.push("Steps: the text is larger than the 4 MB limit.");
  const kind = b.kind === "master" ? "master" : b.kind === "sop" || b.kind === undefined ? (current?.kind ?? "sop") : null;
  if (!kind) errors.push("kind must be sop or master");
  const noPlan = b.plan === undefined || b.plan === null || (typeof b.plan === "string" && !b.plan.trim());
  if (noPlan && !current && !body.trim()) errors.push("Steps: write at least one line saying what the skill should do.");
  // No explicit plan: a new skill (or one whose steps were derived) takes its steps from the body's headings;
  // a new master skill starts from the master plan; an edited custom plan is kept.
  const v = !noPlan ? validatePlan(b.plan)
    : current && !isDerived(current) ? { ok: true as const, plan: current.plan }
      : validatePlan(kind === "master" && !current ? masterPlan() : planFromBody(body));
  if (!v.ok) errors.push(...v.errors);
  if (errors.length) throw new SkillError(400, errors);
  const plan = (v as { plan: Plan }).plan;
  const anchors = new Set(sections(body).map((s) => s.anchor));
  for (const s of plan.steps) if (s.section && !anchors.has(s.section)) errors.push(`Your steps mention a section called '${pretty(s.section)}', but there's no heading '${pretty(s.section)}' in the text. Add that heading back, or remove the step.`);
  if (errors.length) throw new SkillError(400, errors);
  composed(db, tenantId, plan, name);
  return { name, description, body, kind: kind!, plan };
}

/** Live check for the editor: the same rules as saving, nothing stored. Returns the step names it would save. */
export function checkSkill(db: DB, tenantId: number, b: SaveInput): { ok: true; steps: string[] } | { ok: false; errors: string[] } {
  try {
    const p = prepare(db, tenantId, b, undefined, true);
    if (p.name && skillByName(db, tenantId, p.name)) return { ok: false, errors: [`A skill named '${p.name}' already exists in your team; pick another name.`] };
    return { ok: true, steps: p.plan.steps.map((s) => s.name ?? s.id) };
  } catch (e) {
    if (e instanceof SkillError) return { ok: false, errors: e.errors };
    throw e;
  }
}

/** Creates a skill in the actor's team. Any member or team lead can create. Returns the new skill. */
export function createSkill(db: DB, u: Actor, b: SaveInput, now = Date.now()): Skill {
  const p = prepare(db, u.tenantId, b);
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

// Approvals were removed (Oct 2026): every team member can run every team skill. The skill_approvals
// table and its rows are kept untouched but no longer read or written.

/** What still points at a skill in its team: live agents and tasks (skill_ref "sop:<id>") and other skills' call_skill steps. */
export function skillUsers(db: DB, s: Skill): string[] {
  const ref = `sop:${s.id}`;
  const agents = (db.prepare("SELECT name FROM team_agents WHERE tenant_id = ? AND skill_ref = ? AND deleted_at IS NULL ORDER BY name").all(s.tenantId, ref) as Array<{ name: string }>).map((r) => `agent '${r.name}'`);
  const tasks = (db.prepare("SELECT name FROM tasks WHERE tenant_id = ? AND skill_ref = ? AND deleted_at IS NULL ORDER BY name").all(s.tenantId, ref) as Array<{ name: string }>).map((r) => `task '${r.name}'`);
  const skills = (db.prepare("SELECT name, plan_json FROM skills WHERE tenant_id = ? AND id <> ? ORDER BY name").all(s.tenantId, s.id) as Array<{ name: string; plan_json: string }>)
    .filter((r) => { try { return (JSON.parse(r.plan_json) as Plan).steps.some((st) => st.action === "call_skill" && st.skill === s.name); } catch { return false; } })
    .map((r) => `skill '${r.name}'`);
  return [...agents, ...tasks, ...skills];
}

/**
 * Delete: same people as edit (creator, team leads, designated lead, system admins), own team only (404 otherwise).
 * Blocked (409) while an agent, task or other skill still uses it. Removes the skill with its versions, approvals,
 * reviews, review cycles and audit rows in one transaction; past runs are kept. One 'delete' audit row (skill_id NULL) records it.
 */
export function deleteSkill(db: DB, u: Actor, id: number, now = Date.now()): void {
  const s = getSkill(db, u, id);
  if (!s) throw new SkillError(404, ["skill not found"]);
  if (!canEdit(db, u, s)) throw new SkillError(403, ["only the skill's creator, team leads, the designated lead and admins can delete it"]);
  const used = skillUsers(db, s);
  if (used.length) throw new SkillError(409, [`'${s.name}' is still used by ${used.join(", ")}. Remove it from ${used.length === 1 ? "that" : "those"} first.`]);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of ["skill_versions", "skill_approvals", "skill_reviews", "skill_review_cycles", "skill_audit"]) db.prepare(`DELETE FROM ${t} WHERE skill_id = ?`).run(s.id);
    db.prepare("DELETE FROM skills WHERE id = ? AND tenant_id = ?").run(s.id, s.tenantId);
    audit(db, u, "delete", null, `deleted skill '${s.name}' (v${s.version})`, s.tenantId, now);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
