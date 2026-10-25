# Cobra YAML workflows

Workflows are declarative YAML files validated by a zod schema (`web/lib/workflows/schema.ts`), exported as JSON Schema at `workflows/workflow.schema.json` (editors pick it up via the `yaml-language-server` comment). No visual editor: YAML is edited in a textarea.

## Format
```yaml
name: my-flow            # unique, kebab-case
version: 1
description: ...
engine: claude-code      # optional: claude-code (default) | codex; overridable per run
prompt: 'Fix: ${{ inputs.task }}'   # optional prompt template (inputs.* refs checked); runs may use it or a free-form prompt
on: { manual: true }     # default; only manual triggers execute today
governance:
  owner: someone@example.com
  approvers: [{ role: admin }, { role: team_lead }, { user: a@b.com }]
  reviewers: []
  required_approvals: 1
inputs:
  repo: { type: string, required: true, pattern: '^[\w.-]+/[\w.-]+$' }
steps:
  - id: build
    uses: agent | github | shell | approval | simulate | noop
    needs: [other_step]
    if: ${{ inputs.issue > 0 && steps.x.outputs.ok == true }}
    with: { ... }        # values may use ${{ inputs.* }}, ${{ steps.<id>.outputs.* }}, ${{ secrets.NAME }},
                         # ${{ run.engine|prompt|prompt_source|repo|mode|branch|id }}
    retries: 1
    timeout: 10m
outputs:
  pr_url: ${{ steps.build.outputs.pr_url }}
```
Expressions: `${{ }}` with dotted paths, comparison, `&&`, `||`, `!` (no parentheses, no function calls). Secrets are resolved at run time from the env file (`COBRA_ENV_FILE`, `/etc/cobra/cobra.env`, or `web/data/cobra.env`) with process.env fallback, and every env-file value is redacted from logs. Secrets are never stored in YAML.

The engine runs steps sequentially in topological order, with retries and timeouts. Step output is capped at 16,000 chars. The `github` step, GitHub file storage and agent clones are restricted to the **team's registered repos** (`team_repos`, managed on `/repos`); `COBRA_GITHUB_ALLOWED_REPOS`, if set, is an extra global ceiling (a repo must be in both). Both fields are optional, so older YAML is unchanged.

## Repos, engine, prompt, runs (Job 11; design in docs/workflow-redesign.md)
- `/repos` (`GET|POST /api/repos`, `DELETE /api/repos?repo=`): team admins and team leads add/remove; members view. The default team is seeded with `vicgupta/cobra-sandbox` and `vicgupta/factory-demo-app` (main) by migration 8.
- Repo fields in the UI are dropdowns of the team's repos.
- `/workflows/new` → "From a template": pick a template (system or team) and a team repo → `POST /api/templates/[name]/attach` creates an instance with `tenant_workflows.repo`.
- Run flow on `/workflows/[name]`: repo → engine → prompt (workflow template or free-form) → mode → inputs → Run. `POST /api/workflows/[name]/runs` body: `{ inputs, repo?, engine?, promptMode?: workflow|custom|none, prompt?, mode?: simulated|real }`. The run stores `agent` (engine), `prompt` (final text), `prompt_source`, `mode`, `repo`, `branch`; the run page shows them and the first log entry (`run`) records them.
- Who can start runs is unchanged (canRun; `/runs/new` test runs stay default-workspace admins only).
- `mode: real` agent steps use the local runner (`web/lib/workflows/local-runner.ts`): workspace `COBRA_WORKSPACES_DIR` (default `/var/lib/cobra/workspaces`)/`<run-id>`; with `GITHUB_TOKEN` + a team repo it clones (token passed via env git config, never argv/logs), else an empty scratch repo and the log says why; runs `claude -p` or `codex exec` headless with a timeout (step `timeout`, default 10m), streams output into the step log, commits changes and pushes `cobra/<run-id>` only (never the default branch, never force). Built-in `agent-run` workflow uses it.

## Governance
- A run is refused unless the exact version (name + sha256 of source) has the required approvals (`workflow_approvals`).
- Who can approve: listed approvers. The self-approval policy `COBRA_WORKFLOW_SELF_APPROVAL` is `admin` by default (an author may approve only if they are an admin), or `allow`/`deny`. Authors are the owner plus the last editor.
- Who can edit/run: admin, team_lead, the owner, or an approver. Any tenant user can create workflows. Editing a workflow changes its hash, so approval resets.

## Templates and instances
- System templates are in `workflows/templates/*.yaml` and are seeded into `workflow_templates` (keyed by name + hash, INSERT OR IGNORE, `current` flag) on DB open.
  - `issue-to-merge`: create_issue (github) → create_pr (agent) → merge (github).
  - `cloud-software-factory` (after Zach Lloyd/Warp): triage → spec → spec_review (approval) → implement → review_and_verify → human_review (approval) → ship (github). Sources:
    - https://www.warp.dev/blog/how-to-build-a-cloud-software-factory-the-automatic-triage-skill
    - https://www.warp.dev/blog/how-to-build-a-cloud-software-factory-add-spec-driven-development-skills
    - https://www.warp.dev/blog/software-factory-build-guide
    - https://www.warp.dev/blog/three-skills-for-spec-driven-development
- Tenants can also save their own templates (`template: true`).
- Templates can't be run or approved. "Use template" creates an **instance**: a new tenant workflow with `template_name` + `template_hash`. One template can have many instances (names `x`, `x-2`, …). Template pages list their instances and show whether each came from the current version.

## Storage
Each tenant workflow has `storage`:
- `database` (default): the source lives in `tenant_workflows`.
- `github`: the source lives as a YAML file at `github_repo`/`github_path`@`github_branch`. It is read and written via the contents API with `GITHUB_TOKEN` from the env file, read at call time. The DB keeps a cache plus `github_sha`/`synced_at`. Saving PUTs with the known sha and refuses to overwrite a file it didn't create unless "import existing" is used. **Sync** pulls changes: a new sha replaces the cached source, resets approval, and clears `updated_by`. Runs always use the approved cached version. The repo must be registered to the team (and within the ceiling, if set).

## Run log
`runs` (workflow, workflow_hash, status, outputs, error) plus `run_step_events` (run_id, step_id, status, attempt, output, truncated, at). View it at `/runs/<id>` or `GET /api/runs/<id>`. Only the runner and admins of the same tenant can see it; anyone else gets 404.

## UI / API / CLI
- Pages: `/repos`, `/workflows`, `/workflows/new`, `/workflows/[name]`, `/workflows/[name]/edit`, `/templates`, `/runs/[id]`.
- API: `GET|POST /api/workflows`, `GET /api/workflows/[name]`, `POST /api/workflows/[name]/approval|runs|sync`, `GET /api/templates/[name]/copy`, `POST /api/templates/[name]/attach`, `GET|POST|DELETE /api/repos`, `GET /api/runs/[id]`.
- CLI: `web/scripts/workflow.mts` (validate, list, approve, schema).

## Open decisions
Expression language (stay minimal or adopt CEL/JSONata?); non-manual triggers (schedule, webhook); per-tenant vs global repo workflows; user uploads of YAML files; sandboxing for `shell` steps (currently host process, admin-gated); whether template edits should notify or upgrade instances; whether team_lead should be able to approve in all tenants; whether workflow management becomes admin-only.
