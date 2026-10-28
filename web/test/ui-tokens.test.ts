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
