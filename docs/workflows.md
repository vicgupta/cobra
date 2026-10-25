# Cobra YAML workflows

Workflows are declarative YAML files validated by a zod schema (`web/lib/workflows/schema.ts`), exported as JSON Schema at `workflows/workflow.schema.json` (editors pick it up via the `yaml-language-server` comment). No visual editor: YAML is edited in a textarea.

## Format
```yaml
name: my-flow            # unique, kebab-case
version: 1
description: ...
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
    with: { ... }        # values may use ${{ inputs.* }}, ${{ steps.<id>.outputs.* }}, ${{ secrets.NAME }}
    retries: 1
    timeout: 10m
outputs:
  pr_url: ${{ steps.build.outputs.pr_url }}
```
Expressions: `${{ }}` with dotted paths, comparison, `&&`, `||`, `!` (no parentheses, no function calls). Secrets are resolved at run time from the env file (`COBRA_ENV_FILE`, `/etc/cobra/cobra.env`, or `web/data/cobra.env`) with process.env fallback, and every env-file value is redacted from logs. Secrets are never stored in YAML.

The engine runs steps sequentially in topological order, with retries and timeouts. Step output is capped at 16,000 chars. The `github` step is restricted to `COBRA_GITHUB_ALLOWED_REPOS`, and tests use only `vicgupta/cobra-sandbox`.

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
- `github`: the source lives as a YAML file at `github_repo`/`github_path`@`github_branch`. It is read and written via the contents API with `GITHUB_TOKEN` from the env file, read at call time. The DB keeps a cache plus `github_sha`/`synced_at`. Saving PUTs with the known sha and refuses to overwrite a file it didn't create unless "import existing" is used. **Sync** pulls changes: a new sha replaces the cached source, resets approval, and clears `updated_by`. Runs always use the approved cached version. The repo must be in the allow-list.

## Run log
`runs` (workflow, workflow_hash, status, outputs, error) plus `run_step_events` (run_id, step_id, status, attempt, output, truncated, at). View it at `/runs/<id>` or `GET /api/runs/<id>`. Only the runner and admins of the same tenant can see it; anyone else gets 404.

## UI / API / CLI
- Pages: `/workflows`, `/workflows/new`, `/workflows/[name]`, `/workflows/[name]/edit`, `/templates`, `/runs/[id]`.
- API: `GET|POST /api/workflows`, `GET /api/workflows/[name]`, `POST /api/workflows/[name]/approval|runs|sync`, `GET /api/templates/[name]/copy`, `GET /api/runs/[id]`.
- CLI: `web/scripts/workflow.mts` (validate, list, approve, schema).

## Open decisions
Expression language (stay minimal or adopt CEL/JSONata?); non-manual triggers (schedule, webhook); per-tenant vs global repo workflows; user uploads of YAML files; sandboxing for `shell` steps (currently host process, admin-gated); whether template edits should notify or upgrade instances; whether team_lead should be able to approve in all tenants; whether workflow management becomes admin-only.
