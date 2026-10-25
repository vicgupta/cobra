# Workflow redesign: team repos, team templates, engine and prompt per run

Status: implemented on branch `v1-workflow-redesign` (approved by Vic on 2026-10-25, 4:52 PM ET).

## 1. Per-team GitHub repo registration
- New table `team_repos (tenant_id, repo, default_branch, created_by, created_at)`, unique per (tenant, repo). Every team (tenant) has its own list; there is no global list.
- The migration seeds the default team with `vicgupta/cobra-sandbox` and `vicgupta/factory-demo-app` (default branch `main`).
- Page `/repos` (nav: Repos). Team admins and team leads can add and remove repos; members can only view. API: `GET|POST /api/repos`, `DELETE /api/repos?repo=owner/name`.
- `checkTeamRepo(db, tenantId, repo)` is the one gate for every GitHub read, write and run: workflow file storage (save, import, sync), `github` steps, and agent runs that clone and push. A repo must be in the team's list. `COBRA_GITHUB_ALLOWED_REPOS`, if set, stays as an optional global ceiling, so the repo must be in both lists.
- Every repo field in the UI (the storage repo on /workflows/new, attaching a template, the run form) is a dropdown filled from the team's repos.
- GitHub features need `GITHUB_TOKEN` (Admin → Settings). When it's missing, the UI says so instead of failing silently.

## 2. Shared team templates
- Templates are per team (`tenant_workflows` rows with `template: true`), shared by everyone in the team rather than owned per user. System templates (`workflows/templates/*.yaml`) stay global and read-only, and can be copied into a team template.
- On /workflows, **New** offers "From a team template": pick a template (team or system) and a repo from the dropdown, which creates a workflow instance. The instance records `template_name`, `template_hash` and the attached `repo` (column `tenant_workflows.repo`).

## 3. Engine choice
- Optional top-level `engine: claude-code | codex` on a workflow or template. It's backward compatible: if it's missing, the default is `claude-code`.
- Each run may override the engine. The run stores `runs.engine`, the run page shows it, and steps can read it as `${{ run.engine }}`. A workflow with an `agent` input (for example test-run) gets that input set to the engine.

## 4. Prompts
- Optional top-level `prompt:` on a workflow, templated with `${{ inputs.* }}`.
- At run time the user picks "Use the workflow prompt" (rendered with the inputs) or "Free-form". The run stores `runs.prompt_source` (`workflow` | `custom`) and the final text in `runs.prompt`. Steps read it as `${{ run.prompt }}`, and the first step log records it.

## 5. Standard run flow
Pick repo → attach a team template (instance) → choose or override engine → give the prompt → choose mode (simulated or real) → Run.
- Any user of the workflow's tenant (members included) can start runs of an approved workflow in their own tenant, including the agent-run flow (team repo, engine, prompt) and `/runs/new` test runs. Still enforced: the exact version must be approved; tenant isolation (other tenants get 404); team repo checks; templates never run. Members still can't edit workflows (unless owner/approver), manage repos, open Settings or /admin, or see agent credential status.
- `simulated` mode records the engine and prompt but executes nothing.
- `real` mode runs the local runner:
  - It creates a scratch workspace at `/var/lib/cobra/workspaces/<run-id>`.
  - With `GITHUB_TOKEN` set and the repo registered to the team, it clones the repo. Otherwise it uses an empty scratch git repo, and the log says why.
  - It runs `claude -p` or `codex exec` headless as the service user, with a timeout, and streams output into the step log.
  - If there are changes, it commits them and pushes to `cobra/<run-id>`, never to the default branch and never with force.
- The built-in workflow `agent-run` is the standard instance for this flow.

## Out of scope / follow-ups
- Workspace isolation beyond a per-run directory: the agents run as the `cobra` user on nova.
- PR creation from the pushed branch.
