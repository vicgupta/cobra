// Rulebook review of SOP skills: admin-managed rules (skill_review_rules), deterministic code checks,
// a stored review record on every create/edit, and the opt-in review cycle (pros, cons, corrections
// with one-click apply/dismiss). Reviews are advice: a low score never blocks saving, approving or running.
import { createHash } from "node:crypto";
import type { DB } from "../db";
import { designatedLead, isSystemAdmin } from "../collab";
import { canonical, validatePlan, type Plan } from "./plan";
import { sectionText } from "./sections";
import { audit, canEdit, getSkill, SkillError, updateSkill, type Actor, type Skill } from "./store";

export type Rule = { id: number; code: string; title: string; description: string; kind: "code" | "llm"; weight: number; advisory: boolean; enabled: boolean; config: Record<string, unknown>; updatedBy: string | null; updatedAt: number };
export type RuleResult = { code: string; title: string; kind: "code" | "llm"; advisory: boolean; weight: number; status: "pass" | "fail" | "not_evaluated"; reason: string };
export type Review = { id: number; skillId: number; contentHash: string; rulesVersion: string; score: number; results: RuleResult[]; trigger: string; createdAt: number };

export const SEED_RULES: Array<Omit<Rule, "id" | "updatedBy" | "updatedAt">> = [
  { code: "plan_valid", title: "Plan validates", description: "The plan passes the JSON Schema and semantic checks.", kind: "code", weight: 3, advisory: false, enabled: true, config: {} },
  { code: "explicit_on_failure", title: "Every step has an explicit on_failure", description: "stop, continue or goto, written out on each step.", kind: "code", weight: 2, advisory: false, enabled: true, config: {} },
  { code: "no_unguarded_merge", title: "No unguarded merge to main", description: "A github merge step needs an earlier approval step and a when condition.", kind: "code", weight: 3, advisory: false, enabled: true, config: {} },
  { code: "secrets_declared", title: "Secrets declared, not inlined", description: "No token-looking values in the body or step arguments; list secret names in steps[].secrets.", kind: "code", weight: 3, advisory: false, enabled: true, config: {} },
  { code: "prompt_length", title: "Prompt length bounded (advisory)", description: "Agent prompts (with their section) stay under the threshold. Advisory: never counts against the score.", kind: "code", weight: 1, advisory: true, enabled: true, config: { max_chars: 20000 } },
  { code: "outputs_exist", title: "Referenced outputs exist", description: "Handoffs and plan outputs only reference outputs that earlier steps declare.", kind: "code", weight: 2, advisory: false, enabled: true, config: {} },
  { code: "final_verification", title: "Final verification or review step", description: "The last step verifies, reviews, checks or tests (or is an approval).", kind: "code", weight: 2, advisory: false, enabled: true, config: {} },
  { code: "deterministic", title: "Deterministic, no freeform branching", description: "Branching only via when conditions and forward goto; no agent-chosen next steps.", kind: "code", weight: 2, advisory: false, enabled: true, config: {} },
  { code: "description_present", title: "Description present", description: "The skill has a one-line description.", kind: "code", weight: 1, advisory: false, enabled: true, config: {} },
  { code: "llm_sop_clarity", title: "SOP clarity (LLM-judged)", description: "LLM-judged: is the SOP clear and unambiguous? Only evaluated when engine credentials are configured; otherwise reported as not evaluated.", kind: "llm", weight: 1, advisory: true, enabled: false, config: {} },
];

export function seedRules(db: DB, now = Date.now()) {
  const ins = db.prepare("INSERT OR IGNORE INTO skill_review_rules (code, title, description, kind, weight, advisory, enabled, config_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?)");
  for (const r of SEED_RULES) ins.run(r.code, r.title, r.description, r.kind, r.weight, r.advisory ? 1 : 0, r.enabled ? 1 : 0, JSON.stringify(r.config), now);
}

type RuleRow = { id: number; code: string; title: string; description: string; kind: "code" | "llm"; weight: number; advisory: number; enabled: number; config_json: string; updated_by: string | null; updated_at: number };
export function listRules(db: DB): Rule[] {
  seedRules(db);
  return (db.prepare("SELECT * FROM skill_review_rules ORDER BY id").all() as RuleRow[]).map((r) => ({ id: r.id, code: r.code, title: r.title, description: r.description, kind: r.kind, weight: r.weight, advisory: !!r.advisory, enabled: !!r.enabled, config: JSON.parse(r.config_json), updatedBy: r.updated_by, updatedAt: r.updated_at }));
}
export const rulesVersion = (rules: Rule[]) => createHash("sha256").update(canonical(rules.map(({ code, weight, advisory, enabled, config, kind }) => ({ code, weight, advisory, enabled, config, kind })))).digest("hex").slice(0, 12);

/** Admin-only: add, edit or disable rules (never delete; audited). Only code rules with known checks are evaluated; others report not_evaluated. */
export function saveRule(db: DB, u: Actor, b: { id?: unknown; code?: unknown; title?: unknown; description?: unknown; weight?: unknown; advisory?: unknown; enabled?: unknown; config?: unknown; kind?: unknown } | null, now = Date.now()): Rule {
  if (!isSystemAdmin(u)) throw new SkillError(403, ["only system admins manage skill rules"]);
  if (!b) throw new SkillError(400, ["missing body"]);
  seedRules(db);
  const weight = b.weight === undefined ? undefined : Number(b.weight);
  if (weight !== undefined && (!Number.isInteger(weight) || weight < 0 || weight > 10)) throw new SkillError(400, ["weight must be an integer 0-10"]);
  let config: string | undefined;
  if (b.config !== undefined) {
    const c = typeof b.config === "string" ? (() => { try { return JSON.parse(b.config as string); } catch { return null; } })() : b.config;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new SkillError(400, ["config must be a JSON object"]);
    if ("max_chars" in c && !(Number.isInteger(c.max_chars) && c.max_chars > 0)) throw new SkillError(400, ["config.max_chars must be a positive integer"]);
    config = JSON.stringify(c);
  }
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
  if (b.id !== undefined) {
    const id = Number(b.id);
    const cur = listRules(db).find((r) => r.id === id);
    if (!cur) throw new SkillError(404, ["rule not found"]);
    db.prepare("UPDATE skill_review_rules SET title = ?, description = ?, weight = ?, advisory = ?, enabled = ?, config_json = ?, updated_by = ?, updated_at = ? WHERE id = ?").run(
      str(b.title, 200) || cur.title, str(b.description, 2000) ?? cur.description, weight ?? cur.weight, b.advisory === undefined ? (cur.advisory ? 1 : 0) : b.advisory ? 1 : 0,
      b.enabled === undefined ? (cur.enabled ? 1 : 0) : b.enabled ? 1 : 0, config ?? JSON.stringify(cur.config), u.email, now, id);
    audit(db, u, "rule_update", null, `${cur.code}: ${JSON.stringify({ weight, enabled: b.enabled, advisory: b.advisory, config: config ? JSON.parse(config) : undefined })}`, null);
    return listRules(db).find((r) => r.id === id)!;
  }
  const code = str(b.code, 63) ?? "";
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(code)) throw new SkillError(400, ["code must be lowercase letters, digits and '_'"]);
  const title = str(b.title, 200);
  if (!title) throw new SkillError(400, ["title is required"]);
  const kind = b.kind === "llm" ? "llm" : "code";
  const r = db.prepare("INSERT OR IGNORE INTO skill_review_rules (code, title, description, kind, weight, advisory, enabled, config_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(code, title, str(b.description, 2000) ?? "", kind, weight ?? 1, b.advisory ? 1 : 0, b.enabled === false ? 0 : 1, config ?? "{}", u.email, now);
  if (!r.changes) throw new SkillError(409, [`rule '${code}' already exists`]);
  audit(db, u, "rule_create", null, code, null);
  return listRules(db).find((x) => x.code === code)!;
}

const SECRET_RE = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const VERIFY_RE = /verif|review|check|test|validat|audit/i;

/** Deterministic checks. Each returns [pass, reason]. Unknown codes → not evaluated. */
function check(code: string, s: Pick<Skill, "body" | "description" | "plan">, raw: unknown, config: Record<string, unknown>): [boolean, string] | null {
  const plan = s.plan as Plan;
  switch (code) {
    case "plan_valid": { const v = validatePlan(raw); return v.ok ? [true, "schema and semantic checks pass"] : [false, v.errors.slice(0, 5).join("; ")]; }
    case "explicit_on_failure": { const miss = plan.steps.filter((x) => x.on_failure === undefined).map((x) => x.id); return miss.length ? [false, `no on_failure on: ${miss.slice(0, 10).join(", ")}${miss.length > 10 ? ` (+${miss.length - 10})` : ""}`] : [true, "every step sets on_failure"]; }
    case "no_unguarded_merge": {
      let approvalSeen = false; const bad: string[] = [];
      for (const x of plan.steps) {
        if (x.action === "approval") approvalSeen = true;
        const merge = x.action === "github" && (x.with.action === "merge" || x.with.action === "merge-pr");
        if (merge && (!approvalSeen || !x.when)) bad.push(x.id);
      }
      const noMergeText = !plan.steps.some((x) => x.action === "shell" && /git\s+push[^\n]*\b(main|master)\b|gh\s+pr\s+merge/.test(String(x.with.run ?? "")));
      if (!noMergeText) bad.push("(shell push/merge to main)");
      return bad.length ? [false, `unguarded merge: ${bad.join(", ")}`] : [true, plan.steps.some((x) => x.action === "github" && String(x.with.action).startsWith("merge")) ? "merge steps follow an approval and have a when condition" : "no merge steps"];
    }
    case "secrets_declared": {
      const hits = plan.steps.filter((x) => Object.values(x.with).some((v) => typeof v === "string" && SECRET_RE.test(v))).map((x) => x.id);
      if (SECRET_RE.test(s.body)) hits.push("(SOP body)");
      return hits.length ? [false, `token-looking value inlined in: ${hits.join(", ")}`] : [true, "no inlined secret values"];
    }
    case "prompt_length": {
      const max = Number(config.max_chars ?? 20000);
      const long = plan.steps.filter((x) => x.action === "agent").map((x) => [x.id, String(x.with.prompt ?? "").length + (x.section ? (sectionText(s.body, x.section) ?? "").length : 0)] as const).filter(([, n]) => n > max);
      return long.length ? [false, `over ${max} chars: ${long.slice(0, 10).map(([i, n]) => `${i} (${n})`).join(", ")}`] : [true, `agent prompts within ${max} chars`];
    }
    case "outputs_exist": {
      const declared = new Map<string, Set<string>>(); const bad: string[] = [];
      const ok = (src: string) => { const p = src.split("."); return p[0] !== "steps" || p[2] === "status" || !!declared.get(p[1])?.has(p[3]); };
      for (const x of plan.steps) { for (const h of x.handoffs) if (!ok(h.from)) bad.push(`${x.id}: ${h.from}`); declared.set(x.id, new Set(Object.keys(x.outputs))); }
      for (const [k, v] of Object.entries(plan.outputs)) if (!ok(v)) bad.push(`outputs.${k}: ${v}`);
      return bad.length ? [false, `missing: ${bad.slice(0, 10).join("; ")}`] : [true, "all referenced outputs are declared"];
    }
    case "final_verification": { const last = plan.steps[plan.steps.length - 1]; return last && (last.action === "approval" || VERIFY_RE.test(`${last.id} ${last.name ?? ""}`)) ? [true, `final step '${last.id}'`] : [false, `final step '${last?.id}' isn't a verification/review step`]; }
    case "deterministic": {
      const bad = plan.steps.filter((x) => Object.keys(x.with).some((k) => /^(next|next_step|choose|branch)$/.test(k)) || (x.when !== undefined && /\$\{\{/.test(x.when))).map((x) => x.id);
      return bad.length ? [false, `freeform branching in: ${bad.join(", ")}`] : [true, "ordered steps; branching only via when and forward goto"];
    }
    case "description_present": return s.description.trim() ? [true, "description set"] : [false, "no description"];
    default: return null;
  }
}

/** Scores a skill against the enabled rules (advisory and unevaluated rules don't count). */
export function grade(db: DB, s: Pick<Skill, "body" | "description" | "plan">, raw: unknown = s.plan, llmAvailable = false): { score: number; results: RuleResult[]; rulesVersion: string } {
  const rules = listRules(db).filter((r) => r.enabled);
  const results: RuleResult[] = rules.map((r) => {
    const base = { code: r.code, title: r.title, kind: r.kind, advisory: r.advisory, weight: r.weight };
    if (r.kind === "llm") return { ...base, status: "not_evaluated", reason: llmAvailable ? "LLM review not run for automatic reviews" : "no engine credentials configured for LLM-judged rules" };
    const c = check(r.code, s, raw, r.config);
    return c ? { ...base, status: c[0] ? "pass" : "fail", reason: c[1] } : { ...base, status: "not_evaluated", reason: "no code check exists for this rule" };
  });
  const counted = results.filter((r) => !r.advisory && r.status !== "not_evaluated");
  const total = counted.reduce((a, r) => a + r.weight, 0);
  const score = total ? Math.round((100 * counted.filter((r) => r.status === "pass").reduce((a, r) => a + r.weight, 0)) / total) : 100;
  return { score, results, rulesVersion: rulesVersion(rules) };
}

export function recordReview(db: DB, s: Skill, trigger: string, now = Date.now()): Review {
  const g = grade(db, s);
  const r = db.prepare("INSERT INTO skill_reviews (tenant_id, skill_id, content_hash, rules_version, score, results_json, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(s.tenantId, s.id, s.contentHash, g.rulesVersion, g.score, JSON.stringify(g.results), trigger, now);
  return { id: Number(r.lastInsertRowid), skillId: s.id, contentHash: s.contentHash, rulesVersion: g.rulesVersion, score: g.score, results: g.results, trigger, createdAt: now };
}

type ReviewRow = { id: number; skill_id: number; content_hash: string; rules_version: string; score: number; results_json: string; trigger: string; created_at: number };
const reviewFrom = (r: ReviewRow): Review => ({ id: r.id, skillId: r.skill_id, contentHash: r.content_hash, rulesVersion: r.rules_version, score: r.score, results: JSON.parse(r.results_json), trigger: r.trigger, createdAt: r.created_at });
export const latestReview = (db: DB, skillId: number): Review | null => { const r = db.prepare("SELECT * FROM skill_reviews WHERE skill_id = ? ORDER BY id DESC LIMIT 1").get(skillId) as ReviewRow | undefined; return r ? reviewFrom(r) : null; };
/** The latest review, grading the skill now if it has none yet (the built-in master skill is created without one). */
export const reviewOrGrade = (db: DB, s: Skill): Review => latestReview(db, s.id) ?? recordReview(db, s, "first-view");
export const reviewHistory = (db: DB, skillId: number): Review[] => (db.prepare("SELECT * FROM skill_reviews WHERE skill_id = ? ORDER BY id DESC LIMIT 20").all(skillId) as ReviewRow[]).map(reviewFrom);

/** Admin re-review on demand (e.g. after rules change). */
export function reReview(db: DB, u: Actor, s: Skill): Review {
  if (!isSystemAdmin(u)) throw new SkillError(403, ["only system admins can re-run the rulebook review"]);
  const r = recordReview(db, s, "admin");
  audit(db, u, "skill_rereview", s.id, `score ${r.score} rules ${r.rulesVersion}`, s.tenantId);
  return r;
}

// ---- Opt-in review cycle
export type Correction = { id: string; rule: string; title: string; detail: string; patch: { plan?: Plan; description?: string } | null; status: "open" | "applied" | "dismissed"; by?: string; at?: number; version?: number };
export type Cycle = { id: number; skillId: number; contentHash: string; reviewId: number | null; requestedBy: string | null; pros: string[]; cons: string[]; corrections: Correction[]; narrative: string | null; status: "open" | "closed"; createdAt: number };

/** Author, the team's leads (designated lead included) and system admins. */
export const canReview = (db: DB, u: Actor, s: Skill) => isSystemAdmin(u) || (u.tenantId === s.tenantId && (u.role === "team_lead" || s.createdBy === u.id || designatedLead(db, s.tenantId)?.id === u.id));

function corrections(s: Skill, results: RuleResult[]): Correction[] {
  const out: Correction[] = [];
  const clone = () => JSON.parse(JSON.stringify(s.plan)) as Plan;
  for (const r of results.filter((x) => x.status === "fail")) {
    const c = (detail: string, patch: Correction["patch"]) => out.push({ id: `${r.code}-${out.length + 1}`, rule: r.code, title: r.title, detail, patch, status: "open" });
    if (r.code === "explicit_on_failure") { const p = clone(); p.steps.forEach((x) => { if (x.on_failure === undefined) x.on_failure = "stop"; }); c("Set on_failure: stop on every step that has none (explicit is the default behaviour).", { plan: p }); }
    else if (r.code === "final_verification") {
      const p = clone(); let id = "verify"; for (let n = 2; p.steps.some((x) => x.id === id); n++) id = `verify-${n}`;
      p.steps.push({ id, name: "Verify the result", action: "simulate", with: { checked: "true" }, handoffs: [], on_failure: "stop", outputs: {}, secrets: [], retries: 0 });
      c(`Append a final '${id}' verification step (replace it with a real check or review).`, { plan: p });
    } else if (r.code === "description_present") { const h = /^#{1,6}\s+(.+)$/m.exec(s.body)?.[1]?.trim(); c("Add a one-line description.", { description: (h ?? `SOP skill ${s.name}`).slice(0, 200) }); }
    else if (r.code === "no_unguarded_merge") c("Add an approval step before the merge and a when condition on it (e.g. steps.review.status == 'succeeded'), or drop the merge and stop at the PR.", null);
    else if (r.code === "secrets_declared") c("Remove the inlined value; list the secret's NAME in the step's secrets and keep the value in the server env file.", null);
    else if (r.code === "prompt_length") c("Advisory: split the long prompt into SOP sections referenced by heading (section) so each step gets only its part.", null);
    else c(`Fix: ${r.reason}`, null);
  }
  return out;
}

type CycleRow = { id: number; skill_id: number; content_hash: string; review_id: number | null; email: string | null; pros_json: string; cons_json: string; corrections_json: string; narrative: string | null; status: "open" | "closed"; created_at: number };
const cycleFrom = (r: CycleRow): Cycle => ({ id: r.id, skillId: r.skill_id, contentHash: r.content_hash, reviewId: r.review_id, requestedBy: r.email, pros: JSON.parse(r.pros_json), cons: JSON.parse(r.cons_json), corrections: JSON.parse(r.corrections_json), narrative: r.narrative, status: r.status, createdAt: r.created_at });
const CYCLE_SQL = "SELECT c.*, u.email FROM skill_review_cycles c LEFT JOIN users u ON u.id = c.requested_by";

export function listCycles(db: DB, u: Actor, s: Skill): Cycle[] {
  if (!canReview(db, u, s)) return [];
  return (db.prepare(`${CYCLE_SQL} WHERE c.skill_id = ? ORDER BY c.id DESC LIMIT 20`).all(s.id) as CycleRow[]).map(cycleFrom);
}

/** "Request review": grades now and derives pros, cons and corrections from the rule results. Never blocks anything. */
export function requestReview(db: DB, u: Actor, s: Skill, now = Date.now()): Cycle {
  if (!canReview(db, u, s)) throw new SkillError(403, ["the author, team leads and system admins can request a review"]);
  const rev = recordReview(db, s, "requested", now);
  const pros = rev.results.filter((r) => r.status === "pass").map((r) => `${r.title}: ${r.reason}`);
  const cons = rev.results.filter((r) => r.status === "fail").map((r) => `${r.title}${r.advisory ? " (advisory)" : ""}: ${r.reason}`);
  const corr = corrections(s, rev.results);
  const narrative = null; // LLM narrative only when engine credentials exist; none are wired for reviews.
  const r = db.prepare("INSERT INTO skill_review_cycles (tenant_id, skill_id, content_hash, review_id, requested_by, pros_json, cons_json, corrections_json, narrative, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(s.tenantId, s.id, s.contentHash, rev.id, u.id, JSON.stringify(pros), JSON.stringify(cons), JSON.stringify(corr), narrative, corr.length ? "open" : "closed", now);
  audit(db, u, "review_request", s.id, `cycle ${r.lastInsertRowid}: score ${rev.score}, ${corr.length} corrections`, s.tenantId);
  return cycleFrom(db.prepare(`${CYCLE_SQL} WHERE c.id = ?`).get(r.lastInsertRowid) as CycleRow);
}

/** apply: saves a new skill version with the correction's patch (re-graded); dismiss: marks it dismissed. */
export function resolveCorrection(db: DB, u: Actor, skillId: number, cycleId: number, correctionId: string, action: unknown, now = Date.now()): { cycle: Cycle; skill: Skill; review: Review | null } {
  const s = getSkill(db, u, skillId);
  if (!s) throw new SkillError(404, ["skill not found"]);
  if (!canReview(db, u, s)) throw new SkillError(403, ["the author, team leads and system admins handle review corrections"]);
  const row = db.prepare(`${CYCLE_SQL} WHERE c.id = ? AND c.skill_id = ?`).get(cycleId, s.id) as CycleRow | undefined;
  if (!row) throw new SkillError(404, ["review not found"]);
  const cycle = cycleFrom(row);
  const c = cycle.corrections.find((x) => x.id === correctionId);
  if (!c) throw new SkillError(404, ["correction not found"]);
  if (c.status !== "open") throw new SkillError(409, [`correction already ${c.status}`]);
  let skill = s, review: Review | null = null;
  if (action === "apply") {
    if (!c.patch) throw new SkillError(400, ["this correction is guidance only; edit the skill to apply it"]);
    if (!canEdit(db, u, s)) throw new SkillError(403, ["you can't edit this skill"]);
    const res = updateSkill(db, u, s.id, { ...(c.patch.plan ? { plan: c.patch.plan } : {}), ...(c.patch.description !== undefined ? { description: c.patch.description } : {}) }, `review correction ${c.id}`, now);
    skill = res.skill;
    review = recordReview(db, skill, "edit", now);
    c.version = skill.version;
  } else if (action !== "dismiss") throw new SkillError(400, ["action must be apply or dismiss"]);
  c.status = action === "apply" ? "applied" : "dismissed"; c.by = u.email; c.at = now;
  const status = cycle.corrections.every((x) => x.status !== "open") ? "closed" : "open";
  db.prepare("UPDATE skill_review_cycles SET corrections_json = ?, status = ? WHERE id = ?").run(JSON.stringify(cycle.corrections), status, cycle.id);
  audit(db, u, `correction_${c.status === "applied" ? "apply" : "dismiss"}`, s.id, `cycle ${cycle.id} ${c.id}${c.version ? ` → v${c.version}` : ""}`, s.tenantId);
  return { cycle: { ...cycle, status }, skill, review };
}
