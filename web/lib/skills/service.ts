// API-facing operations for SOP skills: {status, body} results; every read is team-scoped (404 across teams).
import type { DB } from "../db";
import { isSystemAdmin } from "../collab";
import { planJsonSchema, MAX_BODY_BYTES, MAX_PLAN_BYTES, MAX_STEPS, MAX_DEPTH, type Plan } from "./plan";
import { sections } from "./sections";
import { approvalState, canApprove, canEdit, composed, createSkill, decide, effectiveHash, getSkill, listSkills, SkillError, updateSkill, versions, type Actor, type SaveInput, type Skill } from "./store";
import { canReview, latestReview, listCycles, listRules, recordReview, reReview, requestReview, resolveCorrection, reviewHistory, saveRule } from "./review";
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

export const STATUSES = ["all", "approved", "pending", "rejected"] as const;
export const parseStatus = (v: unknown) => (STATUSES as readonly string[]).includes(String(v)) ? (v as (typeof STATUSES)[number]) : "all";

export function summaryOf(db: DB, s: Skill) {
  const a = approvalState(db, s), r = latestReview(db, s.id);
  const team = db.prepare("SELECT name FROM tenants WHERE id = ?").get(s.tenantId) as { name: string } | undefined;
  return { id: s.id, name: s.name, kind: s.kind, version: s.version, description: s.description, builtin: s.builtin, tenantId: s.tenantId, team: team?.name ?? "", steps: s.plan.steps.length, status: a.status, score: r?.score ?? null, updatedAt: s.updatedAt };
}

export const list = (db: DB, u: Actor, status: unknown = "all") => wrap(() => {
  const f = parseStatus(status);
  return ok({ skills: listSkills(db, u).map((s) => summaryOf(db, s)).filter((s) => f === "all" || s.status === f) });
});

export function detail(db: DB, u: Actor, id: unknown) {
  return wrap(() => {
    const s = find(db, u, id);
    let kids: Array<{ id: number; name: string; version: number }> = [], composeError: string | null = null;
    try { kids = [...composed(db, s.tenantId, s.plan, s.name).values()].map((k) => ({ id: k.id, name: k.name, version: k.version })); } catch (e) { composeError = e instanceof Error ? e.message : String(e); }
    const runs = db.prepare("SELECT id, status, mode, started_at AS startedAt, ended_at AS endedAt, triggered_by AS triggeredBy FROM runs WHERE tenant_id = ? AND workflow = ? ORDER BY started_at DESC LIMIT 20").all(s.tenantId, `skill:${s.name}`);
    const audit = db.prepare("SELECT actor_email AS actor, action, detail, at FROM skill_audit WHERE skill_id = ? ORDER BY id DESC LIMIT 50").all(s.id);
    return ok({
      skill: s, summary: summaryOf(db, s), sections: sections(s.body).map(({ anchor, title, level }) => ({ anchor, title, level })),
      effective: effectiveHash(db, s), composed: kids, composeError, approval: approvalState(db, s), review: latestReview(db, s.id), reviews: reviewHistory(db, s.id),
      cycles: listCycles(db, u, s), versions: versions(db, s.id), runs, audit: canReview(db, u, s) ? audit : [],
      can: { edit: canEdit(db, u, s), approve: canApprove(u, s), review: canReview(db, u, s), rereview: isSystemAdmin(u), run: u.tenantId === s.tenantId || isSystemAdmin(u) },
    });
  });
}

export const create = (db: DB, u: Actor, b: SaveInput | null) => wrap(() => {
  const s = createSkill(db, u, b ?? {});
  return ok({ skill: s, review: recordReview(db, s, "create") }, 201);
});
export const update = (db: DB, u: Actor, id: unknown, b: SaveInput | null) => wrap(() => {
  const r = updateSkill(db, u, Number(id), b ?? {});
  return ok({ skill: r.skill, changed: r.changed, review: r.changed ? recordReview(db, r.skill, "edit") : latestReview(db, r.skill.id) });
});
export const approve = (db: DB, u: Actor, id: unknown, b: { decision?: unknown; comment?: unknown } | null) => wrap(() => ok(decide(db, u, find(db, u, id), b?.decision, b?.comment)));
export const rereview = (db: DB, u: Actor, id: unknown) => wrap(() => ok(reReview(db, u, find(db, u, id))));
export const startReview = (db: DB, u: Actor, id: unknown) => wrap(() => ok(requestReview(db, u, find(db, u, id)), 201));
export const correction = (db: DB, u: Actor, id: unknown, b: { cycle?: unknown; correction?: unknown; action?: unknown } | null) =>
  wrap(() => ok(resolveCorrection(db, u, Number(id), Number(b?.cycle), String(b?.correction ?? ""), b?.action)));

/** Starts a run; returns its id at once (the run continues in the background). */
export const run = (db: DB, u: Actor, id: unknown, b: { inputs?: unknown; mode?: unknown; repo?: unknown } | null, deps: SkillDeps) => wrap(() => {
  const s = find(db, u, id);
  const repo = typeof b?.repo === "string" ? b.repo.trim() : "";
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new SkillError(400, ["repo must look like owner/name"]);
  const inputs = b?.inputs && typeof b.inputs === "object" && !Array.isArray(b.inputs) ? (b.inputs as Record<string, unknown>) : {};
  const r = startSkillRun(db, { tenantId: s.tenantId, userId: u.id, email: u.email }, s, inputs, deps, { mode: b?.mode === "real" ? "real" : "simulated", repo });
  void r.done;
  return ok({ id: r.id, url: `/runs/${r.id}` }, 202);
});

export const rules = (db: DB, u: Actor) => (isSystemAdmin(u) ? ok({ rules: listRules(db) }) : ok({ error: "Not found" }, 404));
export const putRule = (db: DB, u: Actor, b: Parameters<typeof saveRule>[2]) => isSystemAdmin(u) ? wrap(() => ok(saveRule(db, u, b))) : ok({ error: "Not found" }, 404);

export const limits = { bodyBytes: MAX_BODY_BYTES, planBytes: MAX_PLAN_BYTES, steps: MAX_STEPS, depth: MAX_DEPTH };
export const schema = () => planJsonSchema();
export type { Plan };
