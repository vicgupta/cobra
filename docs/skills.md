# Skills (SOPs)

A skill is a standard operating procedure: markdown text (the SOP) plus an ordered JSON plan. Skills are stored and executed natively; they are never converted to workflow YAML and the workflow tables and Workflows UI are unchanged. UI: **Skills** in the nav (`/skills`, `/skills/new`, `/skills/<id>`, `/skills/<id>/edit`); rulebook at **Settings > Skill rules** (system admins); docs at Settings > Docs > Skills.

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
- Steps run in order. `when` skips a step; `on_failure` is `stop` (default), `continue` or `{goto: <later step>}`; `retries`, `timeout_s`; `secrets` lists names only.
- `section` references a heading anchor in the SOP (`## Implement` → `implement`). The section text is appended to the agent prompt; the whole SOP is written to `.cobra/SOP.md` in the checkout (mode 600, added to `.git/info/exclude`).
- Body-only skill: an empty plan derives one agent step (`run`) with input `goal`.
- Limits: SOP 4 MB, plan JSON 4 MB, 2000 steps, `call_skill` depth 4. Validation errors are returned as a list. Prompts over 20 000 characters only fail the advisory `prompt_length` rule.
- JSON Schema: `planJsonSchema()` in `web/lib/skills/plan.ts`; `POST /api/skills/validate` gives live validation plus a grade preview.

## Master skill

Each team has a built-in `workflow` skill (kind `master`). It is an ordinary skill; compose others with `call_skill`. Cycles and depth > 4 are rejected when saving. Each child runs as its own run.

## Approval and runs

- Real runs require an approval of the **effective hash** (own SOP+plan + every composed skill, recursively + every referenced agent's content hash). Any change returns the skill to pending; an unknown agent keeps it pending.
- Approvers: system admins and team leads of the skill's team. An author's approval counts only if they are an admin. One approval approves; any reject blocks.
- **Simulated runs are dry runs and need no approval**: agent and GitHub steps run in simulated mode, shell commands are not executed (result `would_run`), approval steps auto-pass.

## Review

- Every create/edit is graded against the rulebook and stored (`skill_reviews`, with the rules version). Score = weighted pass rate of enabled, non-advisory, evaluated rules. Shown to approvers; never blocks saving, approving or running. Admins can **Re-review**.
- Seed rules: plan_valid, explicit_on_failure, no_unguarded_merge, secrets_declared, prompt_length (advisory), outputs_exist, final_verification, deterministic, description_present, llm_sop_clarity (LLM-judged, disabled; reported as not evaluated — no LLM is called).
- **Request review** (author, team leads, designated lead, admins) creates a cycle with pros, cons and corrections. Apply saves a new version (re-graded, needs re-approval); dismiss records it. All audited in `skill_audit`.

## Visibility

Skills are team-scoped: other teams get 404. System admins see all teams. Isolation is app-level; see [ROADMAP.md](ROADMAP.md).

## API

`GET/POST /api/skills`, `GET/PUT /api/skills/<id>`, `POST /api/skills/<id>/{approval,review,correction,rereview,run}`, `POST /api/skills/validate`, `GET/POST /api/skill-rules` (admin).
