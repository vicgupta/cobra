// Runs a team agent, manually or from its cron schedule. Prompt agents use the existing direct-run path
// (service.runAgent / runDirect). Skill agents run their one skill: SOP skills through the skill executor
// (skr_ runs, real runs need the skill approved), text skills through runDirect with the skill text.
// Optional extra instructions are passed as the skill's inputs (prompt / instructions / task).
import type { DB } from "./db";
import { getAgent, skillAgentRefs, textSkillsDir, type TeamAgent } from "./agents";
import { canMerge } from "./collab";
import { runAgent, runDirect, type Res, type RunDeps } from "./workflows/service";
import type { Actor } from "./workflows/store";
import { buildPrompt, loadTextSkills } from "./text-skills";
import { startSkillRun } from "./skills/executor";
import { getSkill, SkillError } from "./skills/store";

export type TeamAgentRunBody = { repo?: unknown; mode?: unknown; instructions?: unknown };
const err = (status: number, error: string): Res => ({ status, body: { error } });
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A stand-in actor for cron runs (no user; runs record triggered_by 'schedule'). */
export const scheduleActor = (tenantId: number): Actor => ({ id: 0, email: "schedule", role: "member", tenantId });

export function runTeamAgent(db: DB, user: Actor, name: string, body: TeamAgentRunBody | null, deps: RunDeps, o: { scheduled?: boolean; textDir?: string } = {}): Res {
  const a = getAgent(db, user.tenantId, name);
  if (!a) return err(404, `agent '${name}' not found`);
  if (!a.skillRef) {
    if (!o.scheduled) return runAgent(db, user, name, body, deps);
    const b = body ?? {};
    return runDirect(db, user, { agent: a.name, engine: a.engine, model: a.model, prompt: a.prompt, hash: a.contentHash, repo: str(b.repo) ?? a.defaultRepo ?? undefined, mode: b.mode, scheduled: true }, deps);
  }
  return runSkillAgent(db, user, a, body ?? {}, deps, o);
}

function runSkillAgent(db: DB, user: Actor, a: TeamAgent, b: TeamAgentRunBody, deps: RunDeps, o: { scheduled?: boolean; textDir?: string }): Res {
  if (b.instructions !== undefined && typeof b.instructions !== "string") return err(400, "instructions must be text");
  const extra = typeof b.instructions === "string" ? b.instructions.trim() : "";
  if (extra.length > 4000) return err(400, "instructions must be at most 4000 characters");
  const mode = b.mode === undefined ? "simulated" : b.mode;
  if (mode !== "simulated" && mode !== "real") return err(400, "mode must be simulated or real");
  const repo = str(b.repo) ?? a.defaultRepo ?? undefined;
  const [kind, ref] = [a.skillRef!.slice(0, a.skillRef!.indexOf(":")), a.skillRef!.slice(a.skillRef!.indexOf(":") + 1)];
  if (kind === "text") {
    const skill = loadTextSkills(o.textDir ?? textSkillsDir()).find((s) => s.id === ref);
    if (!skill) return err(404, `text skill '${ref}' not found`);
    const r = runDirect(db, user, { agent: a.name, engine: a.engine, model: a.model, prompt: buildPrompt(skill, extra || "Follow the skill.", o.scheduled ? false : canMerge(db, user)), hash: a.contentHash, repo, mode, purpose: `Agent ${a.name} · text skill ${skill.id}`, scheduled: o.scheduled }, deps);
    return { ...r, body: { ...(r.body as object), skill: `text:${skill.id}` } };
  }
  const s = getSkill(db, { role: "member", tenantId: user.tenantId }, Number(ref));
  if (!s) return err(404, `the skill for agent '${a.name}' no longer exists; edit the agent and pick another skill`);
  // Loop guard at run time too (the skill may have changed since the agent was saved).
  if (skillAgentRefs(db, user.tenantId, s.id).has(a.name)) return err(409, `loop: skill '${s.name}' calls agent '${a.name}'; refusing to run`);
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return err(400, "repo must look like owner/name");
  const inputs = extra ? { prompt: extra, instructions: extra, task: extra } : {};
  try {
    const who = o.scheduled ? { tenantId: user.tenantId, userId: null, email: "schedule" } : { tenantId: user.tenantId, userId: user.id, email: user.email };
    const r = startSkillRun(db, who, s, inputs, deps, { mode, repo: repo ?? "", parent: `agent ${a.name}` });
    void r.done;
    return { status: 201, body: { id: r.id, url: `/runs/${r.id}`, agent: a.name, skill: `sop:${s.id}`, mode } };
  } catch (e) {
    if (e instanceof SkillError) return { status: e.status, body: { error: e.errors[0], errors: e.errors } };
    throw e;
  }
}
