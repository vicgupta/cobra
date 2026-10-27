import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
function walk(d: string): string[] {
  return readdirSync(path.join(root, d)).flatMap((n) => { const f = path.join(d, n); return statSync(path.join(root, f)).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f] : []; });
}

test("Agents toggle reads 'Agents / Skills'; no 'Skills library' left anywhere in the UI", () => {
  const tabs = read("components/agents-tabs.tsx");
  assert.match(tabs, /tab\("\/agents", "Agents", /);
  assert.match(tabs, /tab\("\/agents\/skills", "Skills", /);
  for (const f of [...walk("app"), ...walk("components")]) assert.doesNotMatch(read(f), /skills library/i, f);
  assert.match(read("app/agents/skills/page.tsx"), /title: "Skills · Agents · Cobra"/);
});

test("Skills view mirrors the Agents view: same header, toggle, count row + primary button, table and empty state", () => {
  const agents = read("app/agents/page.tsx"), skills = read("app/agents/skills/page.tsx"), list = read("components/skills.tsx");
  const header = '<header><h1 className="text-2xl font-semibold tracking-tight">Agents</h1>';
  assert.ok(agents.includes(header) && skills.includes(header));
  assert.match(skills, /<AgentsTabs active="skills" \/>/);
  assert.match(list, /<EmptyState title="No skills yet"/);
  assert.match(list, /rows\.length === 1 \? "skill" : "skills"/);
  assert.match(list, /href="\/agents\/skills\/new">New skill<\/Link>/);
  assert.match(list, /className=\{th\}>Skill<\/th>/);
});

test("no built-in skills: none listed on Agents / Skills, none selectable in the agent or task pickers, loader and files gone", () => {
  for (const gone of ["skills", "lib/text-skills", "components/text-skills.tsx", "app/api/text-skills"]) assert.ok(!existsSync(path.join(root, gone)), gone);
  for (const f of [...walk("app"), ...walk("components"), ...walk("lib")]) {
    const s = read(f);
    assert.doesNotMatch(s, /text-skills|loadTextSkills|Built-in skills|TextSkillRun/, f);
  }
  for (const f of ["app/agents/page.tsx", "app/tasks/page.tsx"]) assert.doesNotMatch(read(f), /`text:/, f);
  assert.match(read("components/agents.tsx"), /kind: "sop";/);
});
