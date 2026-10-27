// Runs a team agent, manually or from its cron schedule. Prompt agents use the existing direct-run path
// (service.runAgent / runDirect). Skill agents run their one skill: team skills through the skill executor
// (skr_ runs). Built-in text skills were removed; agents still pointing at one get a plain 400.
// Optional extra instructions are passed as the skill's inputs (prompt / instructions / task).
import type { DB } from "./db";
import { finalPrompt, getAgent, skillAgentRefs, type TeamAgent } from "./agents";
import { runAgent, runDirect, type Res, type RunDeps } from "./workflows/service";
import type { Actor } from "./workflows/store";
import { startSkillRun } from "./skills/executor";
import { getSkill, SkillError } from "./skills/store";

export type TeamAgentRunBody = { repo?: unknown; mode?: unknown; instructions?: unknown };
const err = (status: number, error: string): Res => ({ status, body: { error } });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A stand-in actor for cron runs (no user; runs record triggered_by 'schedule'). */
export const scheduleActor = (tenantId: number): Actor => ({ id: 0, email: "schedule", role: "member", tenantId });

/** Options: scheduled (no user; triggered_by = triggeredBy ?? 'schedule'), skillRef (a task's skill override). */
export type RunOpts = { scheduled?: boolean; skillRef?: string | null; triggeredBy?: string; task?: string };

export function runTeamAgent(db: DB, user: Actor, name: string, body: TeamAgentRunBody | null, deps: RunDeps, o: RunOpts = {}): Res {
  const a = getAgent(db, user.tenantId, name);
  if (!a) return err(404, `agent '${name}' not found`);
  const ref = o.skillRef || a.skillRef;
  if (!ref) {
    if (!o.scheduled && !o.task) return runAgent(db, user, name, body, deps);
    const b = body ?? {};
    if (b.instructions !== undefined && typeof b.instructions !== "string") return err(400, "instructions must be text");
    const prompt = finalPrompt(a.prompt, b.instructions);
    return runDirect(db, user, { agent: a.name, engine: a.engine, model: a.model, prompt, hash: a.contentHash, repo: str(b.repo) ?? a.defaultRepo ?? undefined, mode: b.mode,
      purpose: o.task ? `Task ${o.task} · agent ${a.name}` : undefined, scheduled: o.scheduled, triggeredBy: o.triggeredBy }, deps);
  }
  return runSkillAgent(db, user, { ...a, skillRef: ref }, body ?? {}, deps, o);
}

function runSkillAgent(db: DB, user: Actor, a: TeamAgent, b: TeamAgentRunBody, deps: RunDeps, o: RunOpts): Res {
  if (b.instructions !== undefined && typeof b.instructions !== "string") return err(400, "instructions must be text");
  const extra = typeof b.instructions === "string" ? b.instructions.trim() : "";
  if (extra.length > 4000) return err(400, "instructions must be at most 4000 characters");
  const mode = b.mode === undefined ? "simulated" : b.mode;
  if (mode !== "simulated" && mode !== "real") return err(400, "mode must be simulated or real");
  const repo = str(b.repo) ?? a.defaultRepo ?? undefined;
  const [kind, ref] = [a.skillRef!.slice(0, a.skillRef!.indexOf(":")), a.skillRef!.slice(a.skillRef!.indexOf(":") + 1)];
  if (kind === "text") return err(400, `agent '${a.name}' uses a built-in skill, and built-in skills were removed; edit it and pick a team skill`);
  const s = getSkill(db, { role: "member", tenantId: user.tenantId }, Number(ref));
  if (!s) return err(404, `the skill for agent '${a.name}' no longer exists; edit the agent and pick another skill`);
  // Loop guard at run time too (the skill may have changed since the agent was saved).
  if (skillAgentRefs(db, user.tenantId, s.id).has(a.name)) return err(409, `loop: skill '${s.name}' calls agent '${a.name}'; refusing to run`);
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return err(400, "repo must look like owner/name");
  const inputs = extra ? { prompt: extra, instructions: extra, task: extra } : {};
  try {
    const who = o.scheduled ? { tenantId: user.tenantId, userId: null, email: o.triggeredBy ?? "schedule" } : { tenantId: user.tenantId, userId: user.id, email: user.email };
    const r = startSkillRun(db, who, s, inputs, deps, { mode, repo: repo ?? "", parent: o.task ? `task ${o.task} · agent ${a.name}` : `agent ${a.name}` });
    void r.done;
    return { status: 201, body: { id: r.id, url: `/runs/${r.id}`, agent: a.name, skill: `sop:${s.id}`, mode } };
  } catch (e) {
    if (e instanceof SkillError) return { status: e.status, body: { error: e.errors[0], errors: e.errors } };
    throw e;
  }
}
