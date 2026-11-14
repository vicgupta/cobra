// One-click engineering automation packs: a prefilled skill + suggested schedule and
// delivery. The catalog lives in task_templates (lib/task-templates.ts, migration 39),
// not in this file, so new templates can be added on nova without a redeploy.
// The user picks a repo and an agent, may edit anything, then confirms.
// Activation creates the skill and the task (lib/tasks.ts + lib/skills/store.ts).
import type { DB } from "./db";
import { createSkill, SkillError, type Actor } from "./skills/store";
import { createTask, TaskError, type Task } from "./tasks";
import type { Skill } from "./skills/store";
import { getTaskTemplate, toLibraryPack, type LibraryPack } from "./task-templates";

export type { LibraryPack };

export function libraryPack(db: DB, key: string): LibraryPack | undefined {
  const t = getTaskTemplate(db, key);
  return t ? toLibraryPack(t) : undefined;
}

export type ActivateInput = {
  pack?: unknown;
  skillName?: unknown;
  skillDescription?: unknown;
  skillBody?: unknown;
  taskName?: unknown;
  agent?: unknown;
  repo?: unknown;
  cron?: unknown;
  enabled?: unknown;
  mode?: unknown;
  instructions?: unknown;
  notifyOn?: unknown;
  notifyEmail?: unknown;
  notifyInApp?: unknown;
  notifyEmails?: unknown;
};

export class LibraryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function activateLibraryPack(db: DB, u: Actor, b: ActivateInput | null): { skill: Skill; task: Task; pack: string } {
  const key = typeof b?.pack === "string" ? b.pack : "";
  const pack = libraryPack(db, key);
  if (!pack) throw new LibraryError(400, "pick a library pack");
  const agent = typeof b?.agent === "string" ? b.agent : "";
  if (!agent.trim()) throw new LibraryError(400, "pick an agent");
  const repo = typeof b?.repo === "string" ? b.repo.trim() : "";
  if (!repo) throw new LibraryError(400, "pick a repo");
  const skillName = typeof b?.skillName === "string" && b.skillName.trim() ? b.skillName : pack.skillName;
  const skillDescription = typeof b?.skillDescription === "string" && b.skillDescription.trim() ? b.skillDescription : pack.skillDescription;
  const skillBody = typeof b?.skillBody === "string" && b.skillBody.trim() ? b.skillBody : pack.skillBody;
  const taskName = typeof b?.taskName === "string" && b.taskName.trim() ? b.taskName : pack.taskName;
  db.exec("BEGIN");
  try {
    const skill = createSkill(db, u, { name: skillName, description: skillDescription, body: skillBody });
    const task = createTask(db, u, {
      name: taskName,
      agent,
      skillRef: `sop:${skill.id}`,
      repo,
      cron: typeof b?.cron === "string" && b.cron.trim() ? b.cron : pack.cron,
      enabled: b?.enabled === undefined ? true : b.enabled,
      mode: b?.mode === undefined ? pack.mode : b.mode,
      instructions: b?.instructions,
      notifyOn: b?.notifyOn === undefined ? pack.notifyOn : b.notifyOn,
      notifyInApp: b?.notifyInApp === undefined ? pack.notifyInApp : b.notifyInApp,
      notifyEmail: b?.notifyEmail === undefined ? pack.notifyEmail : b.notifyEmail,
      notifyEmails: b?.notifyEmails === undefined ? [] : b.notifyEmails,
    });
    db.exec("COMMIT");
    return { skill, task, pack: pack.key };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    if (e instanceof LibraryError) throw e;
    if (e instanceof SkillError) throw new LibraryError(e.status, e.errors[0] ?? e.message);
    if (e instanceof TaskError) throw new LibraryError(e.status, e.message);
    throw e;
  }
}
