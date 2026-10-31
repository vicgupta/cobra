# Skills (SOPs)

A skill is a standard operating procedure: markdown text (the SOP) plus an ordered JSON plan. Skills are stored and executed natively; they are never converted to workflow YAML and the workflow tables and Workflows UI are unchanged. UI: **Skills** in the nav (`/skills`, `/skills/new`, `/skills/<id>`, `/skills/<id>/edit`); docs at Settings > Docs > Skills.

## Plan

```json
{
  "inputs": { "task": { "type": "string", "required": true, "description": "What to do" } },
  "steps": [
    { "id": "implement", "action": "agent", "section": "implement",
      "with": { "prompt": "Task: {{task}}" }, "handoffs": [{ "from": "inputs.task", "to": "task" }],
      "on_failure": "stop", "outputs": { "summary": "result.summary" } },
    { "id": "review", "action": "agent", "when": "steps.implement.status == 'succeeded'",
      "with": { "prompt": "Review: {{s}}" }, "handoffs": [{ "from": "steps.implement.outputs.summary", "to": "s" }],
      "on_failure": { "goto": "report" } },
    { "id": "report", "action": "agent", "with": { "prompt": "Summarise" } }
  ],
  "outputs": { "summary": "steps.review.outputs.summary" }
}
```

- Actions: `agent` (`with.agent` names a saved agent or `with.prompt`), `shell`, `github`, `approval`, `simulate`, `call_skill` (`skill`, `with` = child inputs).
- Steps run in order. `when` skips a step; `on_failure` is `stop` (default), `continue` or `{goto: <later step>}`; `retries`, `timeout_seconds`; `secrets` lists names only.
- `section` references a heading anchor in the SOP (`## Implement` → `implement`). The section text is appended to the agent prompt; the whole SOP is written to `.cobra/SOP.md` in the checkout (mode 600, added to `.git/info/exclude`).
- Body-only skill: an empty plan derives one agent step (`run`) with input `prompt`.
- Limits: SOP 4 MB, plan JSON 4 MB, 2000 steps, `call_skill` depth 4. Validation errors are returned as a list. Prompts over 20 000 characters only fail the advisory `prompt_length` rule.
- JSON Schema: `planJsonSchema()` in `web/lib/skills/plan.ts`; `POST /api/skills/validate` gives live validation plus a grade preview.

## Master skill

Each team has a built-in `workflow` skill (kind `master`). It is an ordinary skill; compose others with `call_skill`. Cycles and depth > 4 are rejected when saving. Each child runs as its own run.

## Approval and runs

- Real runs require an approval of the **effective hash** (own SOP+plan + every composed skill, recursively + every referenced agent's content hash). Any change returns the skill to pending; an unknown agent keeps it pending.
- Approvers: system admins and team leads of the skill's team. An author's approval counts only if they are an admin. One approval approves; any reject blocks.
- **Simulated runs are dry runs and need no approval**: agent steps run in simulated mode, GitHub steps are never sent to GitHub (logged as would-run), shell commands are not executed (result `would_run`), approval steps auto-pass.

## Writing skills: style guide

Each step runs as its own agent call. The steps of one run usually share one workspace (one clone, branch `cobra/<run-id>`), but files are not guaranteed to survive: a server restart, a retry or a different runner can start a step in a fresh workspace. The only thing always passed on is the previous step's text summary, in the prompt.

1. **Stateless steps.** Write each step so it works from a clean checkout of the repo plus the previous step's summary. Don't depend on files or notes left by earlier steps. If a later step needs something, have the earlier step put it in its summary.
2. **Explicit early exit.** Say in the skill when to stop, with a clear signal: for example, "if there is nothing to do, start your summary with `NOTHING TO FILE`". Tell later steps: "if the previous summary starts with `NOTHING TO FILE`, do nothing and say so." Cobra does not yet stop the run on this signal by itself, so the skill text is what keeps later steps cheap.
3. **Idempotent, cheap steps.** A re-run or retry should cost the same as the first pass and not duplicate side effects. Check before creating (search for an existing issue, branch or PR before opening one), avoid heavy repeated work, and keep outputs small.

## Review

The MVP has no rulebook or review score: approval alone gates real runs. Old `skill_review_rules`, `skill_reviews` and `skill_review_cycles` rows stay in the database (kept for v1 rollback) and are not read.

## Visibility

Skills are team-scoped: other teams get 404. System admins see all teams. Isolation is app-level; see [ROADMAP.md](ROADMAP.md).

## API

`GET/POST /api/skills`, `GET/PUT /api/skills/<id>`, `POST /api/skills/<id>/{approval,run}`, `POST /api/skills/validate`.
