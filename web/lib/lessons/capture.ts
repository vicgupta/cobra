// Lesson capture: deterministic heuristics over a team's run logs (runs + run_step_events), no LLM.
// Scoped per team AND repo: a run without a repo (or with a repo that isn't one of its team's repos) is
// never captured (safe default: nothing to file it under). Heuristics, all within the same team repo:
//   repeat   - the same step failed with the same error signature in >= 2 runs (30 days)
//   retry    - a step succeeded only after more than one attempt
//   slow     - a step took > SLOW_FACTOR x that step's median over >= 3 earlier successful runs
//   fix      - a step that failed earlier (same error signature) later succeeded with a different prompt
// Same signature (team, repo, kind, workflow, step, error) -> the existing row gets the run id and more
// confidence instead of a new row. At most dailyMax() new pending lessons per team per 24h.
// All text is cleaned (secret values + credential patterns redacted, log boilerplate stripped, capped).
// Staleness: a newer run that contradicts an approved lesson, or N runs without its signature, marks it
// stale (back in the review queue with the reason and run link).
import { createHash } from "node:crypto";
import type { DB } from "../db";
import { lessonAudit, repoIdFor } from "./store";
import { CAPS, clean, cleanTags, keywords } from "./text";

const DAY = 86_400_000;
export const WINDOW_DAYS = 30;
export const SLOW_FACTOR = 3;
export const STALE_AFTER_RUNS = 10;
export const dailyMax = () => { const n = Number(process.env.COBRA_LESSONS_DAILY_MAX); return Number.isInteger(n) && n > 0 ? n : 5; };

type RunRow = { id: string; tenant_id: number; repo: string; workflow: string | null; status: string | null; error: string | null; prompt: string; started_at: number; ended_at: number | null };
type Ev = { step_id: string; status: string; attempt: number; output: string | null; at: number };
export type StepFacts = { stepId: string; status: string; attempts: number; ms: number | null; error: string | null };

/** Per-step facts for one run: final status, attempts, duration (first running -> terminal) and the failure text. */
export function stepFacts(db: DB, runId: string, run?: Pick<RunRow, "error">): StepFacts[] {
  const evs = db.prepare("SELECT step_id, status, attempt, output, at FROM run_step_events WHERE run_id = ? AND step_id <> 'run' ORDER BY id").all(runId) as Ev[];
  const by = new Map<string, { start: number | null; end: number | null; status: string; attempts: number; error: string | null }>();
  for (const e of evs) {
    const s = by.get(e.step_id) ?? { start: null, end: null, status: "pending", attempts: 0, error: null };
    if (e.status === "running" && s.start === null) s.start = e.at;
    if (e.status !== "pending" && e.status !== "running") { s.end = e.at; s.status = e.status; }
    s.attempts = Math.max(s.attempts, e.attempt);
    if (e.status === "failed") s.error = e.output || run?.error || "failed";
    by.set(e.step_id, s);
  }
  return [...by.entries()].map(([stepId, s]) => ({ stepId, status: s.status, attempts: s.attempts, ms: s.start !== null && s.end !== null ? s.end - s.start : null, error: s.error }));
}

/** The most telling error line (an "error"/"failed" line, else the last line), cleaned and short. */
export function errorLine(text: string, secrets: Iterable<string> = []): string {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\[(stdout|stderr|log|summary)\]$/i.test(l));
  const hit = lines.find((l) => /\b(error|failed|fatal|exception|denied|not found|timed? ?out|refused)\b/i.test(l)) ?? lines[lines.length - 1] ?? "failed";
  return clean(hit, 120, secrets);
}
/** Normalised error signature: numbers, hex ids, paths and quoted strings removed, so the same failure matches across runs. */
export function errorSig(line: string): string {
  const n = line.toLowerCase().replace(/\[redacted\]/g, "").replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b/g, "#").replace(/\d+/g, "#").replace(/(["'`]).*?\1/g, "_").replace(/(\/[\w.-]+)+/g, "/p").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(n).digest("hex").slice(0, 12);
}
const sig = (kind: string, wf: string, step: string, e = "") => `${kind}|${wf}|${step}|${e}`;
export const parseSig = (s: string | null) => { const [kind, wf, step, e] = (s ?? "").split("|"); return { kind, workflow: wf ?? "", step: step ?? "", err: e ?? "" }; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const secs = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`);
const wfLabel = (wf: string) => wf.replace(/^(agent|skill|engine):/, "");

type Draft = { kind: string; signature: string; stepId: string; title: string; whatHappened: string; whatWeLearned: string; confidence: number; evidence: string; tags: string[] };
export type CaptureResult = { skipped?: "no-run" | "running" | "no-repo"; created: number[]; updated: number[]; rateLimited: number; stale: number[] };

/** Earlier finished runs of the same workflow in the same team repo (newest first). */
function priorRuns(db: DB, r: RunRow, since: number): RunRow[] {
  return db.prepare("SELECT id, tenant_id, repo, workflow, status, error, prompt, started_at, ended_at FROM runs WHERE tenant_id = ? AND lower(repo) = lower(?) AND workflow IS ? AND id <> ? AND started_at >= ? AND started_at <= ? AND status IN ('succeeded','failed') ORDER BY started_at DESC LIMIT 200")
    .all(r.tenant_id, r.repo, r.workflow, r.id, since, r.started_at) as RunRow[];
}

/** Drafts for one finished run (pure read; no writes). */
export function draftsForRun(db: DB, r: RunRow, secrets: Iterable<string> = [], now = Date.now()): Draft[] {
  const wf = r.workflow ?? "run", label = wfLabel(wf);
  const facts = stepFacts(db, r.id, r);
  const prior = priorRuns(db, r, now - WINDOW_DAYS * DAY).map((p) => ({ run: p, facts: stepFacts(db, p.id, p) }));
  const baseTags = cleanTags([label, ...keywords(label)]);
  const out: Draft[] = [];
  for (const f of facts) {
    const tags = cleanTags([...baseTags, f.stepId]);
    if (f.status === "failed" && f.error) {
      const line = errorLine(f.error, secrets), e = errorSig(line);
      const same = prior.filter((p) => p.facts.some((x) => x.stepId === f.stepId && x.status === "failed" && x.error && errorSig(errorLine(x.error, secrets)) === e));
      if (same.length >= 1) {
        const n = same.length + 1;
        out.push({ kind: "repeat", signature: sig("repeat", wf, f.stepId, e), stepId: f.stepId, title: `${label}: step ${f.stepId} keeps failing`,
          whatHappened: `Step ${f.stepId} failed ${n} times with: ${line}`, whatWeLearned: `Fix the cause of "${line}" before rerunning ${label}; retrying alone doesn't help.`,
          confidence: Math.min(0.9, 0.3 + 0.15 * (n - 1)), evidence: clean(f.error, CAPS.evidence, secrets), tags: cleanTags([...tags, ...keywords(line)]) });
      }
    }
    if (f.status === "succeeded" && f.attempts > 1) {
      out.push({ kind: "retry", signature: sig("retry", wf, f.stepId), stepId: f.stepId, title: `${label}: step ${f.stepId} is flaky`,
        whatHappened: `Step ${f.stepId} only succeeded on attempt ${f.attempts}.`, whatWeLearned: `Expect retries on ${f.stepId}; make it idempotent or stabilise it.`,
        confidence: 0.3, evidence: "", tags });
    }
    if (f.status === "succeeded" && f.ms !== null) {
      const past = prior.flatMap((p) => p.facts.filter((x) => x.stepId === f.stepId && x.status === "succeeded" && x.ms !== null).map((x) => x.ms!));
      if (past.length >= 3) {
        const m = median(past);
        if (m > 0 && f.ms > SLOW_FACTOR * m && f.ms - m >= 5000) out.push({ kind: "slow", signature: sig("slow", wf, f.stepId), stepId: f.stepId, title: `${label}: step ${f.stepId} can run slow`,
          whatHappened: `Step ${f.stepId} took ${secs(f.ms)} vs a usual ${secs(m)}.`, whatWeLearned: `Budget extra time for ${f.stepId}; check for large inputs or network waits.`,
          confidence: 0.3, evidence: "", tags: cleanTags([...tags, "slow"]) });
      }
    }
    if (f.status === "succeeded") {
      // Most recent earlier failure of this step (a different prompt = a different approach).
      // Only right after the failure (the previous run of this workflow in this repo), so later successes don't re-fire it.
      const fail = prior[0]?.facts.some((x) => x.stepId === f.stepId && x.status === "failed" && x.error) ? prior[0] : undefined;
      if (fail && (fail.run.prompt ?? "").trim() !== (r.prompt ?? "").trim()) {
        const fx = fail.facts.find((x) => x.stepId === f.stepId && x.status === "failed")!;
        const line = errorLine(fx.error!, secrets);
        const changed = keywords(r.prompt ?? "").filter((w) => !keywords(fail.run.prompt ?? "").includes(w)).slice(0, 6);
        out.push({ kind: "fix", signature: sig("fix", wf, f.stepId, errorSig(line)), stepId: f.stepId, title: `${label}: fix for ${f.stepId} failure`,
          whatHappened: `Step ${f.stepId} failed with "${line}", then passed with a changed prompt.`,
          whatWeLearned: changed.length ? `For "${line}", give the agent: ${changed.join(", ")} (as in run ${r.id}).` : `For "${line}", reuse the prompt from run ${r.id}.`,
          confidence: 0.45, evidence: clean(fx.error!, CAPS.evidence, secrets), tags: cleanTags([...tags, ...keywords(line), ...changed]) });
      }
    }
  }
  return out.map((d) => ({ ...d, title: clean(d.title, CAPS.title, secrets), whatHappened: clean(d.whatHappened, CAPS.what_happened, secrets), whatWeLearned: clean(d.whatWeLearned, CAPS.what_we_learned, secrets) }));
}

function getRun(db: DB, id: string): RunRow | undefined {
  return db.prepare("SELECT id, tenant_id, repo, workflow, status, error, prompt, started_at, ended_at FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

/** Capture + staleness for one finished run. Safe to call more than once for the same run (idempotent). */
export function captureForRun(db: DB, runId: string, secrets: Iterable<string> = [], now = Date.now()): CaptureResult {
  const res: CaptureResult = { created: [], updated: [], rateLimited: 0, stale: [] };
  const r = getRun(db, runId);
  if (!r) return { ...res, skipped: "no-run" };
  if (r.status !== "succeeded" && r.status !== "failed") return { ...res, skipped: "running" };
  const repoId = repoIdFor(db, r.tenant_id, r.repo);
  if (!repoId) return { ...res, skipped: "no-repo" };
  const sec = [...secrets];
  const find = db.prepare("SELECT id, status, source_run_ids, confidence FROM lessons WHERE tenant_id = ? AND repo_id = ? AND signature = ?");
  for (const d of draftsForRun(db, r, sec, now)) {
    const ex = find.get(r.tenant_id, repoId, d.signature) as { id: number; status: string; source_run_ids: string; confidence: number } | undefined;
    if (ex) {
      const ids: string[] = JSON.parse(ex.source_run_ids);
      if (ids.includes(r.id)) continue;
      ids.push(r.id);
      db.prepare("UPDATE lessons SET source_run_ids = ?, confidence = ?, evidence = CASE WHEN ? <> '' THEN ? ELSE evidence END, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(ids.slice(-50)), Math.min(0.95, ex.confidence + 0.1), d.evidence, d.evidence, now, ex.id);
      lessonAudit(db, r.tenant_id, ex.id, "system", "capture_merge", r.id, now);
      res.updated.push(ex.id);
      continue;
    }
    const recent = (db.prepare("SELECT count(*) n FROM lessons WHERE tenant_id = ? AND created_by = 'system' AND created_at > ?").get(r.tenant_id, now - DAY) as { n: number }).n;
    if (recent >= dailyMax()) { res.rateLimited++; continue; }
    const ins = db.prepare(`INSERT INTO lessons (tenant_id, repo_id, status, title, what_happened, what_we_learned, tags, confidence, kind, signature, step_id, source_run_ids, evidence, created_by, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?)`).run(r.tenant_id, repoId, d.title, d.whatHappened, d.whatWeLearned, JSON.stringify(d.tags), d.confidence, d.kind, d.signature, d.stepId, JSON.stringify([r.id]), d.evidence, now, now);
    const id = Number(ins.lastInsertRowid);
    lessonAudit(db, r.tenant_id, id, "system", "capture", `${d.kind} ${r.id}`, now);
    res.created.push(id);
  }
  res.stale = contradictions(db, r, repoId, now);
  return res;
}

export function markStale(db: DB, tenantId: number, id: number, reason: string, runId: string | null, now = Date.now()) {
  db.prepare("UPDATE lessons SET status = 'stale', stale_reason = ?, stale_run_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'approved'").run(clean(reason, CAPS.reason), runId, now, id, tenantId);
  lessonAudit(db, tenantId, id, "system", "stale", `${reason}${runId ? ` (${runId})` : ""}`, now);
}

/** Approved repeat/retry lessons in this team repo that this run contradicts (the step now passes first time). */
function contradictions(db: DB, r: RunRow, repoId: number, now: number): number[] {
  const facts = stepFacts(db, r.id, r);
  const rows = db.prepare("SELECT id, signature, source_run_ids FROM lessons WHERE tenant_id = ? AND repo_id = ? AND status = 'approved' AND kind IN ('repeat','retry')").all(r.tenant_id, repoId) as Array<{ id: number; signature: string; source_run_ids: string }>;
  const out: number[] = [];
  for (const l of rows) {
    const s = parseSig(l.signature);
    if (s.workflow !== (r.workflow ?? "run") || (JSON.parse(l.source_run_ids) as string[]).includes(r.id)) continue;
    const f = facts.find((x) => x.stepId === s.step);
    if (f && f.status === "succeeded" && f.attempts <= 1) {
      markStale(db, r.tenant_id, l.id, s.kind === "repeat" ? `A later run passed step ${s.step} on the first try` : `Step ${s.step} passed first time again`, r.id, now);
      out.push(l.id);
    }
  }
  return out;
}

/** Approved signature lessons whose signature hasn't recurred in the last STALE_AFTER_RUNS runs of that workflow in that repo. */
export function staleByAbsence(db: DB, tenantId: number, now = Date.now()): number[] {
  const rows = db.prepare("SELECT l.id, l.signature, l.source_run_ids, r.repo FROM lessons l JOIN team_repos r ON r.id = l.repo_id WHERE l.tenant_id = ? AND l.status = 'approved' AND l.signature IS NOT NULL AND l.kind IN ('repeat','retry','slow')").all(tenantId) as Array<{ id: number; signature: string; source_run_ids: string; repo: string }>;
  const out: number[] = [];
  for (const l of rows) {
    const s = parseSig(l.signature), src = new Set(JSON.parse(l.source_run_ids) as string[]);
    const last = db.prepare("SELECT id FROM runs WHERE tenant_id = ? AND lower(repo) = lower(?) AND workflow IS ? AND status IN ('succeeded','failed') ORDER BY started_at DESC LIMIT ?").all(tenantId, l.repo, s.workflow, STALE_AFTER_RUNS) as Array<{ id: string }>;
    if (last.length < STALE_AFTER_RUNS || last.some((x) => src.has(x.id))) continue;
    markStale(db, tenantId, l.id, `Not seen in the last ${STALE_AFTER_RUNS} runs`, last[0].id, now);
    out.push(l.id);
  }
  return out;
}

/** Nightly sweep for one team: capture over the last 24h of finished runs (idempotent), then staleness by absence. */
export function sweepTeam(db: DB, tenantId: number, secrets: Iterable<string> = [], now = Date.now()) {
  const ids = db.prepare("SELECT id FROM runs WHERE tenant_id = ? AND repo <> '' AND status IN ('succeeded','failed') AND coalesce(ended_at, started_at) > ? ORDER BY started_at").all(tenantId, now - DAY) as Array<{ id: string }>;
  let created = 0, updated = 0;
  for (const { id } of ids) { const r = captureForRun(db, id, secrets, now); created += r.created.length; updated += r.updated.length; }
  return { runs: ids.length, created, updated, stale: staleByAbsence(db, tenantId, now).length };
}
