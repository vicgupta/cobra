// API-facing operations for SOP skills: {status, body} results; every read is team-scoped (404 across teams).
import { recordInjected, selectLessons } from "../lessons/inject";
import type { DB } from "../db";
import { planJsonSchema, MAX_BODY_BYTES, MAX_PLAN_BYTES, MAX_STEPS, MAX_DEPTH, type Plan } from "./plan";
import { sections } from "./sections";
import { canEdit, composed, createSkill, deleteSkill, effectiveHash, getSkill, listSkills, SkillError, updateSkill, versions, type Actor, type SaveInput, type Skill } from "./store";
import { startSkillRun, type SkillDeps } from "./executor";

export type Res = { status: number; body: unknown };
const ok = (body: unknown, status = 200): Res => ({ status, body });
export const wrap = (f: () => Res): Res => {
  try { return f(); } catch (e) {
    if (e instanceof SkillError) return { status: e.status, body: { error: e.errors[0], errors: e.errors } };
    throw e;
  }
};
const find = (db: DB, u: Actor, id: unknown) => { const s = getSkill(db, u, Number(id)); if (!s) throw new SkillError(404, ["skill not found"]); return s; };


export function summaryOf(db: DB, s: Skill) {
  const team = db.prepare("SELECT name FROM tenants WHERE id = ?").get(s.tenantId) as { name: string } | undefined;
  return { id: s.id, name: s.name, kind: s.kind, version: s.version, description: s.description, builtin: s.builtin, tenantId: s.tenantId, team: team?.name ?? "", steps: s.plan.steps.length, updatedAt: s.updatedAt };
}

export const list = (db: DB, u: Actor) => wrap(() => ok({ skills: listSkills(db, u).map((s) => summaryOf(db, s)) }));

export function detail(db: DB, u: Actor, id: unknown) {
  return wrap(() => {
    const s = find(db, u, id);
    let kids: Array<{ id: number; name: string; version: number }> = [], composeError: string | null = null;
    try { kids = [...composed(db, s.tenantId, s.plan, s.name).values()].map((k) => ({ id: k.id, name: k.name, version: k.version })); } catch (e) { composeError = e instanceof Error ? e.message : String(e); }
    const runs = db.prepare("SELECT id, status, mode, started_at AS startedAt, ended_at AS endedAt, triggered_by AS triggeredBy FROM runs WHERE tenant_id = ? AND workflow = ? ORDER BY started_at DESC LIMIT 20").all(s.tenantId, `skill:${s.name}`);
    const audit = db.prepare("SELECT actor_email AS actor, action, detail, at FROM skill_audit WHERE skill_id = ? ORDER BY id DESC LIMIT 50").all(s.id);
    return ok({
      skill: s, summary: summaryOf(db, s), sections: sections(s.body).map(({ anchor, title, level }) => ({ anchor, title, level })),
      effective: effectiveHash(db, s), composed: kids, composeError,
      versions: versions(db, s.id), runs, audit: canEdit(db, u, s) ? audit : [],
      can: { edit: canEdit(db, u, s), run: u.tenantId === s.tenantId },
    });
  });
}

export const create = (db: DB, u: Actor, b: SaveInput | null) => wrap(() => {
  const s = createSkill(db, u, b ?? {});
  return ok({ skill: s }, 201);
});
export const update = (db: DB, u: Actor, id: unknown, b: SaveInput | null) => wrap(() => {
  const r = updateSkill(db, u, Number(id), b ?? {});
  return ok({ skill: r.skill, changed: r.changed });
});

export const remove = (db: DB, u: Actor, id: unknown) => wrap(() => { deleteSkill(db, u, Number(id)); return ok({ ok: true }); });

/** Starts a run; returns its id at once (the run continues in the background). */
export const run = (db: DB, u: Actor, id: unknown, b: { inputs?: unknown; mode?: unknown; repo?: unknown } | null, deps: SkillDeps) => wrap(() => {
  const s = find(db, u, id);
  const repo = typeof b?.repo === "string" ? b.repo.trim() : "";
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SkillError(400, ["repo must look like owner/name"]);
  const inputs = b?.inputs && typeof b.inputs === "object" && !Array.isArray(b.inputs) ? (b.inputs as Record<string, unknown>) : {};
  const picked = selectLessons(db, s.tenantId, repo, `${s.name} ${Object.values(inputs).filter((v) => typeof v === "string").join(" ")}`);
  const r = startSkillRun(db, { tenantId: s.tenantId, userId: u.id, email: u.email }, s, inputs, deps, { mode: b?.mode === "real" ? "real" : "simulated", repo, lessons: picked.block || undefined });
  recordInjected(db, r.id, picked.ids);
  void r.done;
  return ok({ id: r.id, url: `/runs/${r.id}` }, 202);
});

export const limits = { bodyBytes: MAX_BODY_BYTES, planBytes: MAX_PLAN_BYTES, steps: MAX_STEPS, depth: MAX_DEPTH };
export const schema = () => planJsonSchema();
export type { Plan };
