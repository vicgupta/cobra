// One-click engineering automation packs: a prefilled skill + suggested schedule and
// delivery. The user picks a repo and an agent, may edit anything, then confirms.
// Activation creates the skill and the task (lib/tasks.ts + lib/skills/store.ts).
import type { DB } from "./db";
import { createSkill, SkillError, type Actor } from "./skills/store";
import { createTask, TaskError, type NotifyOn, type Task } from "./tasks";
import type { Skill } from "./skills/store";

export type LibraryPack = {
  key: string;
  title: string;
  summary: string;
  skillName: string;
  skillDescription: string;
  skillBody: string;
  taskName: string;
  cron: string;
  scheduleLabel: string;
  notifyOn: NotifyOn;
  notifyInApp: boolean;
  notifyEmail: boolean;
  mode: "simulated" | "real";
};

export const LIBRARY_PACKS: LibraryPack[] = [
  {
    key: "morning-brief",
    title: "Morning PR & issue brief",
    summary: "A weekday morning summary of open pull requests and issues in the repo.",
    skillName: "morning-pr-issue-brief",
    skillDescription: "Summarise open pull requests and issues for the team.",
    skillBody: `# Morning PR and issue brief

## List open work
In this repo, list open pull requests and open issues. For each PR: author, title, age, review status, and whether CI is green. For each issue: title, labels, and age. Don't change any files.

## Write the brief
Write a short markdown brief: what landed yesterday if you can tell, what is waiting on review, what is blocked, and the three things most worth attention today. Keep it under a page.

## Report
Return only the brief. Don't open, comment on, or close anything.`,
    taskName: "morning-brief",
    cron: "0 9 * * 1-5",
    scheduleLabel: "Weekdays at 9:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    key: "stale-prs",
    title: "Stale PR reminder",
    summary: "Find pull requests with no update for a week and remind the team.",
    skillName: "stale-pr-reminder",
    skillDescription: "List stale pull requests and draft a reminder.",
    skillBody: `# Stale PR reminder

## Find stale pull requests
In this repo, list open pull requests with no new commits, reviews or comments for at least 7 days. Note the author, title, last activity, and who is requested as a reviewer. Don't change any files.

## Draft reminders
For each stale PR, write one short, polite reminder (what is waiting and how long). Don't post the reminder unless this is a real run and the task instructions explicitly say to comment.

## Report
Return a list of stale PRs and the drafted reminders.`,
    taskName: "stale-prs",
    cron: "0 10 * * 1-5",
    scheduleLabel: "Weekdays at 10:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    key: "ci-digest",
    title: "CI failure digest",
    summary: "Collect recent CI failures on the default branch and group them.",
    skillName: "ci-failure-digest",
    skillDescription: "Summarise recent CI failures on the default branch.",
    skillBody: `# CI failure digest

## Gather failures
In this repo, look at recent CI / GitHub Actions runs on the default branch and on open pull requests. List the failed or cancelled runs from the last 24 hours: workflow name, branch, commit, and a short error excerpt if one is easy to get. Don't change any files.

## Group and explain
Group failures that look like the same cause. For each group, say how many runs, which PRs or commits are affected, and a likely cause if the logs make it obvious.

## Report
Return a short digest. Don't rerun workflows or push fixes unless the task instructions explicitly ask for a fix.`,
    taskName: "ci-digest",
    cron: "0 8 * * 1-5",
    scheduleLabel: "Weekdays at 8:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    key: "review-follow-up",
    title: "Unanswered review follow-up",
    summary: "Find review comments and change requests that haven't been answered.",
    skillName: "unanswered-review-follow-up",
    skillDescription: "Find unanswered review comments and requested changes.",
    skillBody: `# Unanswered review follow-up

## Find unanswered reviews
In this repo, look at open pull requests for review comments, requested changes, or pending reviewers with no reply for at least 2 days. Note the PR, the reviewer, the request, and how long it has been waiting. Don't change any files.

## Draft follow-ups
For each item, write one short follow-up the author or reviewer could use. Don't post comments unless this is a real run and the task instructions explicitly say to comment.

## Report
Return the list and the drafted follow-ups.`,
    taskName: "review-follow-up",
    cron: "0 11 * * 1-5",
    scheduleLabel: "Weekdays at 11:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
  {
    key: "weekly-health",
    title: "Weekly repo health",
    summary: "A Monday snapshot of PR cycle time, issue backlog, and stale work.",
    skillName: "weekly-repo-health",
    skillDescription: "Weekly snapshot of repo health: PRs, issues, and stale work.",
    skillBody: `# Weekly repo health

## Collect numbers
In this repo, for the last 7 days, collect: PRs opened, merged and still open; average time-to-merge if you can estimate it; issues opened and closed; CI pass rate on the default branch if it is easy to see. Also list PRs and issues with no activity for 14 days or more. Don't change any files.

## Write the snapshot
Write a short weekly health note: what improved, what got stuck, and two or three recommended actions for the coming week.

## Report
Return only the snapshot.`,
    taskName: "weekly-health",
    cron: "0 9 * * 1",
    scheduleLabel: "Mondays at 9:00 AM ET",
    notifyOn: "both",
    notifyInApp: true,
    notifyEmail: false,
    mode: "simulated",
  },
];

export const libraryPack = (key: string): LibraryPack | undefined => LIBRARY_PACKS.find((p) => p.key === key);

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
  const pack = libraryPack(key);
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
