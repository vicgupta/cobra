import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "../lib/workflows/loader";
import { STEP_TYPES, GITHUB_ACTIONS } from "../lib/workflows/schema";
import { workflowExamples, templateExamples, HANDLER_DOCS, fieldReference } from "../lib/docs/workflow-docs";

test("every docs example parses with the real loader", () => {
  const all = [...workflowExamples(), ...templateExamples()];
  assert.ok(all.length >= 6);
  for (const e of all) {
    const origin = e.origin.startsWith("workflows/templates") ? "template" : e.origin.startsWith("workflows/") ? "repo" : "tenant";
    const w = parseWorkflow(e.source, e.origin, origin); // throws on any schema or reference error
    assert.equal(w.workflow.name, e.title);
  }
  for (const e of templateExamples()) assert.equal(parseWorkflow(e.source, e.origin, "template").workflow.template, true);
});

test("handler docs cover exactly the real handlers and github actions", () => {
  assert.deepEqual([...new Set(HANDLER_DOCS.map((h) => h.uses))].sort(), [...STEP_TYPES].sort());
  assert.deepEqual(HANDLER_DOCS.filter((h) => h.uses === "github").map((h) => h.action).sort(), [...GITHUB_ACTIONS].sort());
});

test("field reference comes from the schema, including limits and descriptions", () => {
  const secs = fieldReference();
  const root = secs.find((s) => s.path === "(root)")!.fields;
  const prompt = root.find((f) => f.name === "prompt")!;
  assert.ok(prompt.limits.includes("max 20000 characters"), JSON.stringify(prompt));
  assert.ok(root.find((f) => f.name === "name")!.required);
  const step = secs.find((s) => s.path === "steps[]")!.fields;
  assert.match(step.find((f) => f.name === "uses")!.type, /"agent"/);
  assert.ok(secs.flatMap((s) => s.fields).some((f) => f.description));
});
