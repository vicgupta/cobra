// Team lessons: migration 35, capture heuristics, review workflow, injection, staleness, sanitization,
// repo + team scoping (no leakage), API auth. Per-repo within each team; the DB is the source of truth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { openDb, type DB } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { CAPS, clean, cleanTags, confidenceLabel, keywords, looksSensitive, parseConfidence, scrub, stripLog } from "../lib/lessons/text";
import { addFeedback, canReview, createLesson, editLesson, getLesson, listAudit, listFeedback, listLessons, repoIdFor, reviewLesson, LessonError, type Actor } from "../lib/lessons/store";
import { captureForRun, dailyMax, errorLine, errorSig, markStale, parseSig, STALE_AFTER_RUNS, stepFacts, sweepTeam } from "../lib/lessons/capture";
import { BLOCK_END, BLOCK_START, DEFAULT_CAP, injectedFor, recordInjected, selectLessons, withLessons } from "../lib/lessons/inject";
import { sanitizeTeam } from "../lib/lessons/sanitize";
import { maybeRunLessonJobs } from "../lib/lessons/jobs";
import * as svc from "../lib/lessons/service";
import { runDirect } from "../lib/workflows/service";
import { getRunDetail } from "../lib/workflows/runner";
import { builtinHandlers } from "../lib/workflows/handlers";
import { checkTeamRepo } from "../lib/repos";
import type { RunDeps } from "../lib/workflows/service";
import { proxy } from "../proxy";

const R1 = "acme/api", R2 = "acme/web", RB = "bee/app";
const H = 3_600_000, DAY = 24 * H, T0 = Date.UTC(2026, 9, 1, 12);

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: Actor["role"], tenant = "acme"): Actor => {
    const id = createUser(db, { email, tenant, tenantName: `Team ${tenant}`, role, password: "pw-1234567890" });
    return { id, email, role, tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t };
  };
  const lead = mk("lead@acme.com", "team_lead"), member = mk("member@acme.com", "member"), admin = mk("admin@acme.com", "admin");
  const bLead = mk("lead@bee.com", "team_lead", "bee"), bMember = mk("member@bee.com", "member", "bee");
  const repo = (t: number, r: string) => db.prepare("INSERT INTO team_repos (tenant_id, repo, created_at) VALUES (?, ?, ?)").run(t, r, T0);
  repo(lead.tenantId, R1); repo(lead.tenantId, R2); repo(bLead.tenantId, RB);
  return { db, lead, member, admin, bLead, bMember };
}
let seq = 0;
type Step = { id: string; status: "succeeded" | "failed"; attempts?: number; ms?: number; error?: string };
function addRun(db: DB, o: { tenantId: number; repo?: string; workflow?: string; at: number; steps: Step[]; prompt?: string }) {
  const id = `run_l${++seq}`;
  const status = o.steps.some((s) => s.status === "failed") ? "failed" : "succeeded";
  db.prepare(`INSERT INTO runs (id, tenant_id, created_by, agent, repo, issue, title, prompt, simulated, started_at, workflow, status, ended_at, triggered_by)
    VALUES (?, ?, NULL, '', ?, 0, 't', ?, 1, ?, ?, ?, ?, 'system')`).run(id, o.tenantId, o.repo ?? "", o.prompt ?? "do the thing", o.at, o.workflow ?? "agent:builder", status, o.at + 60_000);
  const ev = db.prepare("INSERT INTO run_step_events (run_id, tenant_id, step_id, status, attempt, output, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const s of o.steps) {
    const n = s.attempts ?? 1;
    for (let a = 1; a <= n; a++) {
      ev.run(id, o.tenantId, s.id, "running", a, null, o.at + 1);
      const last = a === n;
      ev.run(id, o.tenantId, s.id, last ? s.status : "failed", a, last ? (s.status === "failed" ? s.error ?? "boom" : "ok") : "transient error: retrying", o.at + 1 + (last ? s.ms ?? 1000 : 10));
    }
  }
  return id;
}
const fail = (error = "Error: npm test failed with exit code 1") => [{ id: "agent", status: "failed" as const, error }];
const ok = (ms = 1000, attempts = 1) => [{ id: "agent", status: "succeeded" as const, ms, attempts }];
const all = (db: DB, t: number) => db.prepare("SELECT * FROM lessons WHERE tenant_id = ? ORDER BY id").all(t) as Array<Record<string, unknown>>;
function approved(db: DB, u: Actor, repo: string, title: string, tags: string[] = [], learned = "Run the linter before pushing.") {
  const l = createLesson(db, u, { title, whatHappened: "Something went wrong once.", whatWeLearned: learned, repo, tags, confidence: "high" });
  return reviewLesson(db, u, l.id, "approve");
}
const deps = (db: DB, t: number): RunDeps => ({ handlers: builtinHandlers({ checkRepo: (r) => checkTeamRepo(db, t, r) }), resolveSecret: () => undefined, redact: () => ["sk-live-SECRET123"] });

// ---------- migration 35 ----------
test("migration 35: user_version 35, lessons/feedback/audit/jobs tables, runs.injected_lessons, indexes", () => {
  const { db } = setup();
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 36);
  for (const t of ["lessons", "lesson_feedback", "lesson_audit", "lesson_jobs"]) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), t);
  const cols = (db.prepare("PRAGMA table_info(lessons)").all() as Array<{ name: string; notnull: number }>);
  for (const c of ["tenant_id", "repo_id", "status", "title", "what_happened", "what_we_learned", "tags", "confidence", "signature", "source_run_ids", "flags_json", "stale_reason", "stale_run_id", "version", "supersedes_id", "approved_by"]) assert.ok(cols.some((x) => x.name === c), c);
  assert.equal(cols.find((c) => c.name === "repo_id")!.notnull, 1, "repo_id is NOT NULL");
  assert.ok((db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).some((c) => c.name === "injected_lessons"));
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lessons'").all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(idx.includes("lessons_tenant_repo") && idx.includes("lessons_tenant_repo_sig"));
});
test("migration 35: CHECKs, repo FK, per-repo unique signature, cascade on repo delete", () => {
  const { db, lead } = setup();
  const r1 = repoIdFor(db, lead.tenantId, R1)!, r2 = repoIdFor(db, lead.tenantId, R2)!;
  const ins = (repo: number, status = "pending", sig: string | null = "s", conf = 0.5) => db.prepare("INSERT INTO lessons (tenant_id, repo_id, status, title, what_happened, what_we_learned, signature, confidence, created_at, updated_at) VALUES (?, ?, ?, 't', 'h', 'l', ?, ?, 1, 1)").run(lead.tenantId, repo, status, sig, conf);
  ins(r1);
  assert.throws(() => ins(r1), /UNIQUE/);
  ins(r2); // same signature, other repo: fine
  ins(r1, "pending", null); ins(r1, "pending", null); // null signatures don't collide
  assert.throws(() => ins(r1, "bogus", "x"), /CHECK/);
  assert.throws(() => ins(r1, "pending", "y", 1.5), /CHECK/);
  assert.throws(() => ins(99999, "pending", "z"), /FOREIGN KEY/);
  db.prepare("DELETE FROM team_repos WHERE id = ?").run(r1);
  assert.equal(all(db, lead.tenantId).length, 1, "lessons of a removed repo cascade away");
});

// ---------- text cleaning ----------
test("text: clean collapses whitespace, strips log noise and caps with ellipsis", () => {
  assert.equal(clean("  a \n\n b\t c ", 100), "a b c");
  const long = clean("word ".repeat(100), CAPS.what_happened);
  assert.equal(long.length, CAPS.what_happened); assert.ok(long.endsWith("…"));
  const s = stripLog("\x1b[31m[stdout]\n2026-10-01T12:00:00Z Error: boom\n    at foo (/app/x.js:1:2)\n");
  assert.doesNotMatch(s, /\x1b|stdout|2026-10-01T|at foo/); assert.match(s, /Error: boom/);
});
test("text: scrub redacts known secrets, KEY=value, bearer/PEM, ghp tokens", () => {
  const out = scrub("token sk-live-SECRET123 and API_KEY=abc123def456 and ghp_abcdefghijklmnopqrstuvwxyz0123456789 -----BEGIN PRIVATE KEY-----\nMIIx\n-----END PRIVATE KEY-----", ["sk-live-SECRET123"]);
  assert.doesNotMatch(out, /sk-live-SECRET123|abc123def456|ghp_abcdefghij|MIIx/);
  assert.equal(clean("pw sk-live-SECRET123", 200, ["sk-live-SECRET123"]).includes("SECRET123"), false);
});
test("text: looksSensitive, tags, keywords, confidence parse/label", () => {
  assert.ok(looksSensitive("mail bob@example.com")); assert.ok(looksSensitive("call +1 (415) 555-1234")); assert.ok(!looksSensitive("Run the linter first"));
  assert.deepEqual(cleanTags(["Lint", "lint", " CI Build ", "", 3, "x".repeat(50)]).slice(0, 2), ["lint", "cibuild"]);
  assert.ok(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length <= CAPS.tags);
  assert.deepEqual(keywords("The tests are failing in the CI"), ["tests", "failing"]);
  assert.equal(parseConfidence("high"), 0.85); assert.equal(parseConfidence(0.2), 0.2); assert.equal(parseConfidence(3), null); assert.equal(parseConfidence("meh"), null);
  assert.deepEqual([confidenceLabel(0.8), confidenceLabel(0.5), confidenceLabel(0.1)], ["high", "medium", "low"]);
});

// ---------- capture ----------
test("capture: stepFacts reads final status, attempts, duration and error", () => {
  const { db, lead } = setup();
  const id = addRun(db, { tenantId: lead.tenantId, repo: R1, at: T0, steps: [{ id: "agent", status: "succeeded", attempts: 3, ms: 4000 }, { id: "push", status: "failed", error: "fatal: denied" }] });
  const f = stepFacts(db, id);
  assert.deepEqual(f.map((x) => [x.stepId, x.status, x.attempts]), [["agent", "succeeded", 3], ["push", "failed", 1]]);
  assert.equal(f[0].ms, 4000); assert.equal(f[1].error, "fatal: denied");
});
test("capture: errorLine picks the telling line; errorSig ignores numbers, ids, paths", () => {
  assert.equal(errorLine("[stdout]\ninstalling\nError: tests failed in 12 files\ndone"), "Error: tests failed in 12 files");
  assert.equal(errorSig("Error: tests failed in 12 files /a/b.ts"), errorSig("Error: tests failed in 3 files /c/d.ts"));
  assert.notEqual(errorSig("Error: tests failed"), errorSig("Error: lint failed"));
  assert.deepEqual(parseSig("repeat|agent:x|agent|abc"), { kind: "repeat", workflow: "agent:x", step: "agent", err: "abc" });
});
test("capture: repeat failure (same step + signature twice in one repo) -> one pending lesson, concise and redacted", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  const a = addRun(db, { tenantId: t, repo: R1, at: T0, steps: fail("Error: npm test failed (sk-live-SECRET123) in 4 files") });
  assert.deepEqual(captureForRun(db, a, ["sk-live-SECRET123"], T0 + H).created, [], "one failure is not a lesson");
  const b = addRun(db, { tenantId: t, repo: R1, at: T0 + H, steps: fail("Error: npm test failed (sk-live-SECRET123) in 9 files") });
  const r = captureForRun(db, b, ["sk-live-SECRET123"], T0 + 2 * H);
  assert.equal(r.created.length, 1);
  const l = getLesson(db, lead, r.created[0])!;
  assert.equal(l.status, "pending"); assert.equal(l.kind, "repeat"); assert.equal(l.repo, R1); assert.equal(l.createdBy, "system");
  for (const f of [l.title, l.whatHappened, l.whatWeLearned, l.evidence]) assert.doesNotMatch(f, /SECRET123/);
  assert.ok(l.title.length <= CAPS.title && l.whatHappened.length <= CAPS.what_happened && l.whatWeLearned.length <= CAPS.what_we_learned);
  assert.deepEqual(l.sourceRunIds, [b]); assert.ok(Math.abs(l.confidence - 0.45) < 1e-9);
});
test("capture: dedupe by signature merges runs and raises confidence; idempotent per run", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  addRun(db, { tenantId: t, repo: R1, at: T0, steps: fail() });
  const b = addRun(db, { tenantId: t, repo: R1, at: T0 + H, steps: fail() });
  const id = captureForRun(db, b, [], T0 + H).created[0];
  const c = addRun(db, { tenantId: t, repo: R1, at: T0 + 2 * H, steps: fail() });
  const r = captureForRun(db, c, [], T0 + 2 * H);
  assert.deepEqual([r.created, r.updated], [[], [id]]);
  assert.deepEqual(captureForRun(db, c, [], T0 + 2 * H).updated, [], "same run twice is a no-op");
  const l = getLesson(db, lead, id)!;
  assert.deepEqual(l.sourceRunIds, [b, c]); assert.ok(Math.abs(l.confidence - 0.55) < 1e-9);
  assert.equal(all(db, t).length, 1);
});
test("capture: retry heuristic (succeeded after more than one attempt)", () => {
  const { db, lead } = setup();
  const id = addRun(db, { tenantId: lead.tenantId, repo: R1, at: T0, steps: ok(1000, 2) });
  const r = captureForRun(db, id, [], T0);
  assert.equal(getLesson(db, lead, r.created[0])!.kind, "retry");
});
test("capture: slow heuristic needs >= 3 baseline runs, 3x median and +5s", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  for (let i = 0; i < 3; i++) addRun(db, { tenantId: t, repo: R1, at: T0 + i * H, steps: ok(2000) });
  const quick = addRun(db, { tenantId: t, repo: R1, at: T0 + 4 * H, steps: ok(5000) });
  assert.deepEqual(captureForRun(db, quick, [], T0 + 5 * H).created, [], "3x+ but under 5s extra is not slow (2.5x anyway)");
  const slow = addRun(db, { tenantId: t, repo: R1, at: T0 + 6 * H, steps: ok(60_000) });
  const r = captureForRun(db, slow, [], T0 + 7 * H);
  const l = getLesson(db, lead, r.created[0])!;
  assert.equal(l.kind, "slow"); assert.match(l.whatHappened, /60s vs a usual 2s/);
});
test("capture: fail -> fix with a changed prompt lists what changed; same prompt is not a fix", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  addRun(db, { tenantId: t, repo: R1, at: T0, steps: fail(), prompt: "fix the bug" });
  const same = addRun(db, { tenantId: t, repo: R1, at: T0 + H, steps: ok(), prompt: "fix the bug" });
  assert.deepEqual(captureForRun(db, same, [], T0 + H).created, []);
  addRun(db, { tenantId: t, repo: R2, at: T0, steps: fail(), prompt: "fix the bug" });
  const fixed = addRun(db, { tenantId: t, repo: R2, at: T0 + H, steps: ok(), prompt: "fix the bug and run npm ci first" });
  const l = getLesson(db, lead, captureForRun(db, fixed, [], T0 + H).created[0])!;
  assert.equal(l.kind, "fix"); assert.equal(l.repo, R2); assert.match(l.whatWeLearned, /npm/);
  const later = addRun(db, { tenantId: t, repo: R2, at: T0 + 2 * H, steps: ok(), prompt: "another prompt" });
  assert.deepEqual(captureForRun(db, later, [], T0 + 2 * H).updated, [], "fix fires only right after the failure");
});
test("capture: runs without a repo, or with a repo not on the team, are never captured", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  addRun(db, { tenantId: t, at: T0, steps: fail() });
  const b = addRun(db, { tenantId: t, at: T0 + H, steps: ok(1000, 3) });
  assert.equal(captureForRun(db, b, [], T0 + H).skipped, "no-repo");
  const c = addRun(db, { tenantId: t, repo: RB, at: T0 + H, steps: ok(1000, 3) });
  assert.equal(captureForRun(db, c, [], T0 + H).skipped, "no-repo", "another team's repo is not ours");
  assert.equal(captureForRun(db, "nope").skipped, "no-run");
  db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(b);
  assert.equal(captureForRun(db, b).skipped, "running");
  assert.equal(all(db, t).length, 0);
});
test("capture: rate limit per team per day (COBRA_LESSONS_DAILY_MAX), other teams unaffected", () => {
  const { db, lead, bLead } = setup();
  process.env.COBRA_LESSONS_DAILY_MAX = "2";
  try {
    assert.equal(dailyMax(), 2);
    let limited = 0;
    for (let i = 0; i < 4; i++) limited += captureForRun(db, addRun(db, { tenantId: lead.tenantId, repo: R1, workflow: `agent:w${i}`, at: T0 + i, steps: ok(1000, 2) }), [], T0 + i).rateLimited;
    assert.equal(all(db, lead.tenantId).length, 2); assert.equal(limited, 2);
    assert.equal(captureForRun(db, addRun(db, { tenantId: bLead.tenantId, repo: RB, at: T0, steps: ok(1000, 2) }), [], T0).created.length, 1);
    assert.equal(captureForRun(db, addRun(db, { tenantId: lead.tenantId, repo: R1, workflow: "agent:next", at: T0 + DAY + 10, steps: ok(1000, 2) }), [], T0 + DAY + 10).created.length, 1, "window rolls after 24h");
  } finally { delete process.env.COBRA_LESSONS_DAILY_MAX; }
});
test("capture: same failure in two repos -> two separate lessons (per-repo signatures)", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  for (const repo of [R1, R2]) { addRun(db, { tenantId: t, repo, at: T0, steps: fail() }); captureForRun(db, addRun(db, { tenantId: t, repo, at: T0 + H, steps: fail() }), [], T0 + H); }
  const ls = listLessons(db, lead);
  assert.equal(ls.length, 2); assert.deepEqual(ls.map((l) => l.repo).sort(), [R1, R2]);
  assert.equal(ls[0].signature, ls[1].signature);
});
test("capture: hook runs at end of a real (simulated) run via runDirect", async () => {
  const { db, member } = setup();
  const r = runDirect(db, member, { engine: "claude-code", prompt: "hello", repo: R1, mode: "simulated" }, deps(db, member.tenantId));
  assert.equal(r.status, 201);
  await r.run!.done; await new Promise((s) => setTimeout(s, 10));
  assert.ok(listAudit(db, member, 1).length >= 0); // hook ran without throwing; a clean run captures nothing
  assert.equal(all(db, member.tenantId).length, 0);
});
test("capture: nightly sweep covers last 24h and is claimed once per team per day", () => {
  const { db, lead } = setup();
  const now = Date.UTC(2026, 9, 2, 8); // 4 AM ET
  addRun(db, { tenantId: lead.tenantId, repo: R1, at: now - 3 * H, steps: ok(1000, 2) });
  const out = maybeRunLessonJobs(db, now);
  assert.match(out[`sweep:${lead.tenantId}`], /1 new/);
  assert.deepEqual(maybeRunLessonJobs(db, now + H), {}, "already claimed today");
  assert.equal(sweepTeam(db, lead.tenantId, [], now).created, 0, "sweep is idempotent");
  assert.deepEqual(maybeRunLessonJobs(openDbWith(), Date.UTC(2026, 9, 2, 5)), {}, "before 2 AM ET nothing runs");
});
function openDbWith() { const db = openDb(":memory:"); createUser(db, { email: "x@y.com", tenant: "t", tenantName: "T", role: "team_lead", password: "pw-1234567890" }); return db; }

// ---------- staleness ----------
test("stale: contradiction (approved flaky lesson, step now passes first time) -> back in queue with reason + run", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  const id = captureForRun(db, addRun(db, { tenantId: t, repo: R1, at: T0, steps: ok(1000, 2) }), [], T0).created[0];
  reviewLesson(db, lead, id, "approve");
  const clean1 = addRun(db, { tenantId: t, repo: R1, at: T0 + H, steps: ok() });
  assert.deepEqual(captureForRun(db, clean1, [], T0 + H).stale, [id]);
  const l = getLesson(db, lead, id)!;
  assert.equal(l.status, "stale"); assert.equal(l.staleRunId, clean1); assert.ok(l.staleReason);
  assert.ok(listLessons(db, lead, { status: "queue" }).some((x) => x.id === id));
  assert.equal(reviewLesson(db, lead, id, "approve").staleReason, null, "re-approving clears stale info");
});
test("stale: contradiction in another repo does not touch this repo's lesson", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  const id = captureForRun(db, addRun(db, { tenantId: t, repo: R1, at: T0, steps: ok(1000, 2) }), [], T0).created[0];
  reviewLesson(db, lead, id, "approve");
  captureForRun(db, addRun(db, { tenantId: t, repo: R2, at: T0 + H, steps: ok() }), [], T0 + H);
  assert.equal(getLesson(db, lead, id)!.status, "approved");
});
test("stale: signature absent for N runs in the repo -> stale via sweep", () => {
  const { db, lead } = setup();
  const t = lead.tenantId;
  addRun(db, { tenantId: t, repo: R1, at: T0, steps: fail() });
  const id = captureForRun(db, addRun(db, { tenantId: t, repo: R1, at: T0 + 1, steps: fail() }), [], T0 + 1).created[0];
  reviewLesson(db, lead, id, "approve");
  const now = T0 + 5 * DAY;
  for (let i = 0; i < STALE_AFTER_RUNS; i++) addRun(db, { tenantId: t, repo: R1, at: now - 2 * DAY + i, steps: [{ id: "x", status: "succeeded" }] });
  sweepTeam(db, t, [], now);
  const l = getLesson(db, lead, id)!;
  assert.equal(l.status, "stale"); assert.match(l.staleReason!, /\d+ runs/); assert.ok(l.staleRunId);
});
test("stale: markStale only affects approved lessons of that team", () => {
  const { db, lead, bLead } = setup();
  const a = approved(db, lead, R1, "Lint first");
  markStale(db, bLead.tenantId, a.id, "x", null);
  assert.equal(getLesson(db, lead, a.id)!.status, "approved");
  markStale(db, lead.tenantId, a.id, "contradicted", "run_1");
  assert.equal(getLesson(db, lead, a.id)!.status, "stale");
});

// ---------- review ----------
test("review: who can review — leads, designated lead, admins in-team; members can't; other teams never", () => {
  const { db, lead, member, admin, bLead } = setup();
  assert.ok(canReview(db, lead)); assert.ok(canReview(db, admin)); assert.ok(!canReview(db, member));
  assert.ok(!canReview(db, bLead, lead.tenantId));
  db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(member.id, member.tenantId); // e.g. a lead later demoted
  assert.ok(canReview(db, member), "designated lead may review");
});
test("review: approve / edit / reject / retire / reopen with valid transitions only (409 otherwise)", () => {
  const { db, lead } = setup();
  const l = createLesson(db, lead, { title: "Pin node 24", whatHappened: "Build broke on node 20.", whatWeLearned: "Use node 24 for node:sqlite.", repo: R1, tags: ["node"] });
  assert.equal(l.status, "pending");
  const e = editLesson(db, lead, l.id, { title: "  Pin   node 24 ", confidence: "medium" });
  assert.equal(e.title, "Pin node 24"); assert.equal(e.version, 2); assert.equal(e.confidenceLabel, "medium");
  assert.equal(reviewLesson(db, lead, l.id, "approve").approvedBy, lead.email);
  assert.throws(() => reviewLesson(db, lead, l.id, "reject"), (x: LessonError) => x.status === 409);
  const r = reviewLesson(db, lead, l.id, "retire", "Superseded by CI image");
  assert.equal(r.status, "retired"); assert.equal(r.retiredReason, "Superseded by CI image");
  assert.equal(reviewLesson(db, lead, l.id, "reopen").status, "pending");
  assert.equal(reviewLesson(db, lead, l.id, "reject").status, "rejected");
  assert.throws(() => reviewLesson(db, lead, l.id, "nuke"), (x: LessonError) => x.status === 400);
  assert.deepEqual(listAudit(db, lead, l.id).map((a) => a.action), ["create", "edit", "approve", "retire", "reopen", "reject"]);
});
test("review: validation — required fields, caps, repo must be a team repo, edits scrubbed", () => {
  const { db, lead } = setup();
  const base = { title: "t", whatHappened: "h", whatWeLearned: "l", repo: R1 };
  assert.throws(() => createLesson(db, lead, { ...base, title: "  " }), (x: LessonError) => x.status === 400);
  assert.throws(() => createLesson(db, lead, { ...base, repo: undefined }), (x: LessonError) => x.status === 400);
  assert.throws(() => createLesson(db, lead, { ...base, repo: RB }), (x: LessonError) => x.status === 400, "other team's repo");
  assert.throws(() => createLesson(db, lead, { ...base, confidence: "bogus" }), (x: LessonError) => x.status === 400);
  const l = createLesson(db, lead, { ...base, whatWeLearned: `set API_KEY=supersecretvalue1 ${"y".repeat(400)}` });
  assert.doesNotMatch(l.whatWeLearned, /supersecretvalue1/); assert.ok(l.whatWeLearned.length <= CAPS.what_we_learned);
});
test("review: members can view and add feedback but not create/edit/approve (403)", () => {
  const { db, lead, member } = setup();
  const l = createLesson(db, lead, { title: "t", whatHappened: "h", whatWeLearned: "l", repo: R1 });
  const is403 = (x: LessonError) => x.status === 403;
  assert.throws(() => createLesson(db, member, { title: "t", whatHappened: "h", whatWeLearned: "l", repo: R1 }), is403);
  assert.throws(() => editLesson(db, member, l.id, { title: "x" }), is403);
  assert.throws(() => reviewLesson(db, member, l.id, "approve"), is403);
  assert.equal(listLessons(db, member).length, 1);
  addFeedback(db, member, l.id, "This also bit us on staging.");
  assert.deepEqual(listFeedback(db, lead, l.id).map((f) => [f.author, f.text]), [[member.email, "This also bit us on staging."]]);
  assert.throws(() => addFeedback(db, member, l.id, "   "), (x: LessonError) => x.status === 400);
});
test("review: queue (pending+stale) vs history (approved/retired/rejected), grouped/sorted by repo, repo filter", () => {
  const { db, lead } = setup();
  const a = createLesson(db, lead, { title: "a", whatHappened: "h", whatWeLearned: "l", repo: R2 });
  const b = approved(db, lead, R1, "b");
  const c = createLesson(db, lead, { title: "c", whatHappened: "h", whatWeLearned: "l", repo: R1 });
  reviewLesson(db, lead, c.id, "reject");
  assert.deepEqual(listLessons(db, lead, { status: "queue" }).map((l) => l.id), [a.id]);
  assert.deepEqual(listLessons(db, lead, { status: "history" }).map((l) => l.id).sort(), [b.id, c.id].sort());
  assert.deepEqual(listLessons(db, lead).map((l) => l.repo), [R1, R1, R2], "sorted by repo");
  assert.deepEqual(listLessons(db, lead, { repo: "ACME/WEB" }).map((l) => l.id), [a.id], "repo filter, case-insensitive");
  assert.deepEqual(listLessons(db, lead, { status: "rejected" }).map((l) => l.id), [c.id]);
});

// ---------- team + repo isolation ----------
test("isolation: other teams (including their admins/leads) can't list, read, edit, review or comment (404)", () => {
  const { db, lead, bLead, bMember } = setup();
  const l = createLesson(db, lead, { title: "t", whatHappened: "h", whatWeLearned: "l", repo: R1 });
  const bAdmin: Actor = { ...bMember, role: "admin" };
  for (const u of [bLead, bMember, bAdmin]) {
    assert.equal(listLessons(db, u).length, 0); assert.equal(getLesson(db, u, l.id), null);
    const is404 = (x: LessonError) => x.status === 404;
    assert.throws(() => editLesson(db, u, l.id, { title: "x" }), is404);
    assert.throws(() => reviewLesson(db, u, l.id, "approve"), is404);
    assert.throws(() => addFeedback(db, u, l.id, "hi"), is404);
    assert.deepEqual(listFeedback(db, u, l.id), []);
  }
  assert.equal(svc.detail(db, bLead, l.id).status, 404);
});
test("isolation: a system admin of another team still only sees their own team's lessons", () => {
  const { db, admin, bLead } = setup();
  approved(db, bLead, RB, "bee lesson");
  assert.equal(listLessons(db, admin).length, 0);
  assert.equal(selectLessons(db, admin.tenantId, RB, "bee lesson").ids.length, 0);
});

// ---------- injection ----------
test("inject: only approved lessons for the exact team + repo; never other repos or teams", () => {
  const { db, lead, bLead } = setup();
  const a = approved(db, lead, R1, "Lint before push", ["lint"]);
  approved(db, lead, R2, "Web lesson", ["lint"]);
  createLesson(db, lead, { title: "Pending lint", whatHappened: "h", whatWeLearned: "l", repo: R1, tags: ["lint"] });
  approved(db, bLead, RB, "Bee lint", ["lint"]);
  const p = selectLessons(db, lead.tenantId, R1, "fix lint");
  assert.deepEqual(p.ids, [a.id]);
  assert.match(p.block, /Lint before push/); assert.doesNotMatch(p.block, /Web lesson|Pending lint|Bee lint/);
  assert.deepEqual(selectLessons(db, lead.tenantId, null, "lint").ids, [], "no repo -> nothing");
  assert.deepEqual(selectLessons(db, lead.tenantId, RB, "lint").ids, [], "another team's repo -> nothing");
  assert.deepEqual(selectLessons(db, bLead.tenantId, R1, "lint").ids, []);
});
test("inject: ranks by tag/keyword match, then confidence; top K", () => {
  const { db, lead } = setup();
  const docs = approved(db, lead, R1, "Docs build", ["docs"]);
  const migr = approved(db, lead, R1, "Database migration order", ["migration", "sqlite"]);
  for (let i = 0; i < 6; i++) approved(db, lead, R1, `Filler ${i}`);
  const p = selectLessons(db, lead.tenantId, R1, "write a sqlite migration for users");
  assert.equal(p.ids[0], migr.id); assert.equal(p.ids.length, 5); assert.ok(!p.ids.slice(0, 1).includes(docs.id));
  assert.equal(selectLessons(db, lead.tenantId, R1, "x", { k: 2 }).ids.length, 2);
});
test("inject: hard char cap (default 4000, configurable) and delimited block format", () => {
  const { db, lead } = setup();
  for (let i = 0; i < 5; i++) approved(db, lead, R1, `Lesson ${i} ${"about the build ".repeat(6)}`, [], "Check the build cache first. ".repeat(7));
  const p = selectLessons(db, lead.tenantId, R1, "task", { cap: 800 });
  assert.ok(p.block.length <= 800); assert.ok(p.ids.length >= 1 && p.ids.length < 5);
  assert.ok(p.block.startsWith(BLOCK_START) && p.block.endsWith(BLOCK_END));
  assert.equal(DEFAULT_CAP, 4000);
  process.env.COBRA_LESSONS_INJECT_CHARS = "300";
  try { assert.ok(selectLessons(db, lead.tenantId, R1, "task").block.length <= 300); } finally { delete process.env.COBRA_LESSONS_INJECT_CHARS; }
  process.env.COBRA_LESSONS_INJECT = "off";
  try { assert.deepEqual(selectLessons(db, lead.tenantId, R1, "task").ids, []); } finally { delete process.env.COBRA_LESSONS_INJECT; }
  assert.equal(withLessons("do it", { ids: [], block: "" }), "do it");
  assert.equal(withLessons("do it", p), `${p.block}\n\ndo it`);
});
test("inject: runDirect prepends the block, records ids on the run, run detail shows them", async () => {
  const { db, lead, member } = setup();
  const a = approved(db, lead, R1, "Run npm ci first", ["npm"]);
  approved(db, lead, R2, "Other repo lesson", ["npm"]);
  const r = runDirect(db, member, { engine: "claude-code", prompt: "update npm deps", repo: R1, mode: "simulated" }, deps(db, member.tenantId));
  assert.equal(r.status, 201);
  await r.run!.done;
  const row = db.prepare("SELECT prompt, injected_lessons FROM runs WHERE id = ?").get(r.run!.id) as { prompt: string; injected_lessons: string };
  assert.deepEqual(JSON.parse(row.injected_lessons), [a.id]);
  assert.ok(row.prompt.startsWith(BLOCK_START)); assert.doesNotMatch(row.prompt, /Other repo lesson/); assert.match(row.prompt, /update npm deps$/);
  assert.deepEqual(getRunDetail(db, r.run!.id)!.injectedLessons, [{ id: a.id, title: a.title, status: "approved" }]);
  const none = runDirect(db, member, { engine: "claude-code", prompt: "no repo here", mode: "simulated" }, deps(db, member.tenantId));
  await none.run!.done;
  assert.equal((db.prepare("SELECT injected_lessons FROM runs WHERE id = ?").get(none.run!.id) as { injected_lessons: string | null }).injected_lessons, null);
});
test("inject: injectedFor is team-scoped; recordInjected ignores empty", () => {
  const { db, lead, bLead } = setup();
  const a = approved(db, lead, R1, "x");
  const id = addRun(db, { tenantId: lead.tenantId, repo: R1, at: T0, steps: ok() });
  recordInjected(db, id, []);
  assert.deepEqual(injectedFor(db, lead.tenantId, id), []);
  recordInjected(db, id, [a.id]);
  assert.deepEqual(injectedFor(db, lead.tenantId, id).map((x) => x.id), [a.id]);
  assert.deepEqual(injectedFor(db, bLead.tenantId, id), []);
});

// ---------- sanitization ----------
test("sanitize: flags duplicates (same repo only), sensitive text, low confidence, idle repo", () => {
  const { db, lead } = setup();
  const now = T0 + 2 * DAY;
  addRun(db, { tenantId: lead.tenantId, repo: R1, at: now - DAY, steps: ok() });
  const a = approved(db, lead, R1, "Run npm ci before tests", ["npm"], "Always run npm ci before the tests.");
  const b = createLesson(db, lead, { title: "Run npm ci before tests", whatHappened: "Something went wrong once.", whatWeLearned: "Always run npm ci before the tests.", repo: R1 });
  const c = createLesson(db, lead, { title: "Run npm ci before tests", whatHappened: "Something went wrong once.", whatWeLearned: "Always run npm ci before the tests.", repo: R2, confidence: 0.2 });
  db.prepare("UPDATE lessons SET evidence = 'contact ops@acme.com' WHERE id = ?").run(b.id);
  sanitizeTeam(db, lead.tenantId, now);
  const kinds = (id: number) => getLesson(db, lead, id)!.flags.map((f) => f.kind).sort();
  assert.deepEqual(kinds(a.id), ["duplicate"]);
  assert.deepEqual(kinds(b.id), ["duplicate", "sensitive"]);
  assert.deepEqual(kinds(c.id), ["low_confidence", "stale"], "R2 has no runs; not a duplicate across repos");
  assert.equal(getLesson(db, lead, a.id)!.status, "approved", "flags never change status");
});
test("sanitize: weekly job runs Mondays from 3 AM ET, once per team", () => {
  const { db, lead } = setup();
  const mon = Date.UTC(2026, 9, 5, 8); // Mon Oct 5 2026, 4 AM ET
  createLesson(db, lead, { title: "t", whatHappened: "h", whatWeLearned: "l", repo: R1, confidence: 0.1 });
  const out = maybeRunLessonJobs(db, mon);
  assert.ok(out[`sanitize:${lead.tenantId}`]);
  assert.equal(maybeRunLessonJobs(db, mon + H)[`sanitize:${lead.tenantId}`], undefined);
  assert.equal(maybeRunLessonJobs(db, Date.UTC(2026, 9, 6, 8))[`sanitize:${lead.tenantId}`], undefined, "not on Tuesday");
});

// ---------- service / API ----------
test("service: list/detail/create/edit/act/feedback status codes", () => {
  const { db, lead, member } = setup();
  const c = svc.create(db, lead, { title: "t", whatHappened: "h", whatWeLearned: "l", repo: R1 });
  assert.equal(c.status, 201);
  const id = (c.body as { lesson: { id: number } }).lesson.id;
  assert.equal(svc.create(db, member, { title: "t", whatHappened: "h", whatWeLearned: "l", repo: R1 }).status, 403);
  assert.equal(svc.create(db, lead, null).status, 400);
  assert.equal(svc.edit(db, member, id, { title: "x" }).status, 403);
  assert.equal(svc.act(db, member, id, { action: "approve" }).status, 403);
  assert.equal(svc.act(db, lead, id, { action: "approve" }).status, 200);
  assert.equal(svc.act(db, lead, id, { action: "approve" }).status, 409);
  assert.equal(svc.act(db, lead, 999, { action: "approve" }).status, 404);
  assert.equal(svc.feedback(db, member, id, { text: "nice" }).status, 201);
  const d = svc.detail(db, member, id);
  assert.equal(d.status, 200); assert.equal((d.body as { feedback: unknown[] }).feedback.length, 1); assert.equal((d.body as { canReview: boolean }).canReview, false);
  const v = svc.list(db, member, "history", R1).body as { lessons: Array<{ feedbackCount: number }>; repos: string[] };
  assert.equal(v.lessons[0].feedbackCount, 1); assert.deepEqual(v.repos, [R1, R2]);
  assert.equal(svc.detail(db, member, "abc").status, 404);
});
test("API: unauthenticated /api/lessons* -> 401 (proxy), pages -> /login", () => {
  for (const p of ["/api/lessons", "/api/lessons/1", "/api/lessons/1/action", "/api/lessons/1/feedback"]) {
    const r = proxy(new NextRequest(`http://localhost${p}`));
    assert.equal(r.status, 401, p);
  }
  assert.equal(proxy(new NextRequest("http://localhost/agents/lessons")).status, 307);
});
test("API: every lessons route guards with apiGuard (401 signed-out, 403 bad origin on writes) and uses the caller's team", () => {
  const dir = path.join(import.meta.dirname, "..", "app", "api", "lessons");
  for (const f of ["route.ts", "[id]/route.ts", "[id]/action/route.ts", "[id]/feedback/route.ts"]) {
    const src = readFileSync(path.join(dir, f), "utf8");
    const handlers = src.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
    assert.ok(handlers.length > 0, f);
    assert.equal((src.match(/const g = await apiGuard\(req\);\s*if \(g\.error\) return g\.error;/g) ?? []).length, handlers.length, f);
    assert.match(src, /actor\(g\.user\)/);
  }
  const guard = readFileSync(path.join(import.meta.dirname, "..", "lib", "auth", "server.ts"), "utf8");
  assert.match(guard, /!sameOrigin\(req\)\) return \{ error: NextResponse\.json\(\{ error: "Bad origin" \}, \{ status: 403 \}\)/);
});
test("UI: Lessons tab under Agents; run page lists injected lessons", () => {
  const root = path.join(import.meta.dirname, "..");
  assert.match(readFileSync(path.join(root, "components", "agents-tabs.tsx"), "utf8"), /"\/agents\/lessons", "Lessons"/);
  assert.match(readFileSync(path.join(root, "app", "runs", "[id]", "page.tsx"), "utf8"), /injected-lessons/);
  const ui = readFileSync(path.join(root, "components", "lessons.tsx"), "utf8");
  for (const s of ["Approve", "Reject", "Retire", "Reopen", "repo-filter", "history-filter", "lesson-edit", "lesson-thread", "stale-reason"]) assert.ok(ui.includes(s), s);
});
