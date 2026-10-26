// Plain-text skills: one markdown file per skill in web/skills/ (no YAML, no plan, no DB).
// Running one sends the skill text plus a free-form prompt to an engine through the
// existing runDirect path, so repo, push (cobra/<run-id> only) and simulated rules are unchanged.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DB } from "../db";
import { canMerge } from "../collab";
import { runDirect, type Res, type RunDeps } from "../workflows/service";
import type { Actor } from "../workflows/store";

export type TextSkill = { id: string; name: string; trigger: string; goal: string; steps: string[]; output: string; text: string };

export const skillsDir = () => path.join(process.cwd(), "skills");

export function parseTextSkill(id: string, text: string): TextSkill {
  const lines = text.split(/\r?\n/);
  const field = (k: string) => lines.find((l) => l.toLowerCase().startsWith(`${k.toLowerCase()}:`))?.slice(k.length + 1).trim() ?? "";
  const name = lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? "";
  const steps = lines.map((l) => /^\s*\d+\.\s+(.*)$/.exec(l)?.[1]).filter((s): s is string => !!s);
  const s = { id, name, trigger: field("Trigger"), goal: field("Goal"), steps, output: field("Output"), text: text.trim() };
  const missing = (["name", "trigger", "goal", "output"] as const).filter((k) => !s[k]);
  if (missing.length) throw new Error(`skill ${id}: missing ${missing.join(", ")}`);
  if (steps.length < 1 || steps.length > 6) throw new Error(`skill ${id}: needs 1-6 steps`);
  return s;
}

export function loadTextSkills(dir = skillsDir()): TextSkill[] {
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => parseTextSkill(f.replace(/\.md$/, ""), readFileSync(path.join(dir, f), "utf8")));
}

/** The skill whose trigger phrase the prompt starts with (else contains); longest trigger wins. */
export function pickByTrigger(skills: TextSkill[], prompt: string): TextSkill | null {
  const p = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const by = (f: (t: string) => boolean) => skills.filter((s) => f(s.trigger.toLowerCase())).sort((a, b) => b.trigger.length - a.trigger.length)[0] ?? null;
  return by((t) => p.startsWith(t)) ?? by((t) => p.includes(t));
}

export function buildPrompt(skill: TextSkill, prompt: string, mayMerge: boolean): string {
  return `${skill.text}\n\n---\nTask:\n${prompt}\n\nFollow the skill above. Push only to this run's cobra/<run-id> branch.\n${mayMerge ? "Merging is allowed for this user if checks pass." : "Merging is NOT allowed for this user: stop after creating the PR and leave it open."}`;
}

export type TextRunBody = { skill?: unknown; prompt?: unknown; engine?: unknown; repo?: unknown; mode?: unknown };

export function runTextSkill(db: DB, user: Actor, body: TextRunBody | null, deps: RunDeps, skills: TextSkill[] = loadTextSkills()): Res & { run?: ReturnType<typeof runDirect>["run"] } {
  const b = body ?? {};
  const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
  if (!prompt) return { status: 400, body: { error: "a prompt is required" } };
  if (prompt.length > 4000) return { status: 400, body: { error: "prompt must be at most 4000 characters" } };
  const named = typeof b.skill === "string" && b.skill ? b.skill : null;
  const skill = named ? skills.find((s) => s.id === named) ?? null : pickByTrigger(skills, prompt) ?? (skills.length === 1 ? skills[0] : null);
  if (!skill) return { status: 400, body: { error: named ? `skill '${named}' not found` : "no skill matches that prompt" } };
  const engine = typeof b.engine === "string" && b.engine ? b.engine : "claude-code";
  const r = runDirect(db, user, { engine, prompt: buildPrompt(skill, prompt, canMerge(db, user)), repo: typeof b.repo === "string" && b.repo ? b.repo : undefined, mode: b.mode, purpose: `Text skill ${skill.id}` }, deps);
  return { ...r, body: { ...(r.body as object), skill: skill.id } };
}
