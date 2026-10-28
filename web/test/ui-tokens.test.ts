import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { focusRing, ghostBtn, inputCls, primaryBtn } from "../components/styles";

test("shared Repos-style tokens: focus ring on buttons, Repos input/button shapes", () => {
  assert.match(focusRing, /focus-visible:ring-2/);
  for (const c of [primaryBtn, ghostBtn]) assert.ok(c.includes(focusRing));
  assert.match(inputCls, /min-h-10 rounded-lg/);
  assert.match(primaryBtn, /min-h-10 .*rounded-lg bg-accent-solid/);
  // same tokens as the Repos issues/PR forms
  const collab = readFileSync(new URL("../components/collab.tsx", import.meta.url), "utf8");
  assert.ok(collab.includes(inputCls.replace(" disabled:cursor-not-allowed disabled:opacity-60", "")));
});

test("PageHeader renders title, description and actions slots", () => {
  const src = readFileSync(new URL("../components/page-header.tsx", import.meta.url), "utf8");
  for (const s of ["data-page-header", "text-2xl font-semibold tracking-tight", "aria-label=\"Breadcrumb\""]) assert.ok(src.includes(s), s);
});

test("Settings tabs use the shared Repos-style tokens; Dashboard/Tasks/Agents untouched by them", () => {
  const r = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  for (const p of ["components/team.tsx", "components/team-invites.tsx", "components/notify-toggle-form.tsx", "components/updates-form.tsx", "app/settings/updates/page.tsx", "components/repos.tsx"]) assert.match(r(p), /styles"|page-header"/, p);
  for (const p of ["app/page.tsx", "app/tasks/page.tsx", "app/agents/page.tsx", "app/agents/skills/page.tsx", "components/tasks.tsx", "components/agents.tsx", "components/skills.tsx", "components/form-ui.tsx"]) assert.ok(!/components\/styles"|\.\/styles"/.test(r(p)), p);
});

test("Settings > Providers mirrors Settings > Repos structure (PageHeader, Suspense skeleton, Card tables, inline row edit)", () => {
  const r = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const v = r("components/providers.tsx"), repos = r("components/repos.tsx"), ie = r("components/inline-edit.tsx");
  for (const s of ["<PageHeader title=", "<Suspense fallback={<ListSkeleton />}>", "<AuthGate>", "<Card title=", "-mx-5 overflow-x-auto", "theadCls", "hover:bg-surface-2/40"]) { assert.ok(v.includes(s), s); }
  for (const s of ["<PageHeader title=", "<Suspense fallback={<ListSkeleton />}>", "<Card title="]) assert.ok(repos.includes(s), s);
  assert.ok(v.includes('<InlineEdit label="Edit defaults">') && ie.includes("ghostBtn") && ie.includes("Cancel"));
  assert.ok(!/secretValue\([^)]*\)\s*[}<]/.test(v), "never renders a secret value");
});
