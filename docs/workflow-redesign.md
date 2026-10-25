# Workflow redesign: team repos, team templates, engine and prompt per run

Status: implemented on branch `v1-workflow-redesign` (approved by Vic on 2026-10-25, 4:52 PM ET).

## 1. Per-team GitHub repo registration
- New table `team_repos (tenant_id, repo, default_branch, created_by, created_at)`, unique per (tenant, repo). Every team (tenant) has its own list; there is no global list.
- The migration seeds the default team with `vicgupta/cobra-sandbox` and `vicgupta/factory-demo-app` (default branch `main`).
- Page `/repos` (nav: Repos). System admins and team leads can add and remove repos; members can only view. API: `GET|POST /api/repos`, `DELETE /api/repos?repo=owner/name`.
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

## 6. Team agents (Job 14)

- **What:** a team agent is a named engine (`claude-code` or `codex`) plus a prompt, with an optional default repo from the team's repos. They live in `team_agents` (migration 9); see `web/lib/agents.ts`.
  - **Version:** `content_hash = sha256(engine + "\n" + prompt)` is the agent's prompt version.
  - **Who can do what:** any team member can list, view, create and run agents, with no limit on how many. Only the creator, team leads and admins can edit or delete one; anyone else gets 403.
  - **Visibility:** other teams never see an agent (404).
- **UI and API:** the `/agents` page is in the nav. The API is `GET/POST /api/agents` and `GET/PATCH/DELETE /api/agents/<name>`.
- **Direct run:** `POST /api/agents/<name>/runs` takes `{ repo?, mode: simulated|real, instructions? }`.
  - It needs no workflow approval, because the agent itself is the unit.
  - The engine is fixed by the agent. The repo must be one of the team's repos and defaults to the agent's default_repo.
  - Extra instructions are appended as `Additional instructions:`.
  - Real runs use the local runner and push to `cobra/<run-id>`.
  - The run is recorded with workflow `agent:<name>` and prompt source `agent`.
- **In workflows:** use `uses: agent` with `with: { agent: <name> }`.
  - The agent's engine overrides `with.driver`; combining the two is a validation error.
  - The agent's prompt is used literally. The step's interpolated `with.prompt`, if any, is appended as extra instructions.
  - `mode` and `repo` default to the run's values.
  - Chaining uses the normal `needs` order plus `${{ steps.<id>.outputs.* }}`.
- **Approval:** the workflow's effective approval hash is `sha256(yaml hash + each referenced agent's name:content_hash)`, computed by `withAgents` in store.ts. Editing or deleting an agent sends every workflow that uses it back to pending.
- **Unknown agent:** a reference to an agent that doesn't exist is a run-time validation error (400). It is listed on the workflow page, and the step badge shows "(unknown)".
- **Logs:** each agent step's log starts with `[agent] <name> @ <hash12> (<engine>, <mode>)` and then `[prompt]` with the final prompt. This shows in the live log and on the run page.
- **Parallel:** **sequential only.** The engine runs steps one at a time in topological order, so independent steps do not run in parallel.
  - When a workflow has several agent steps, each one gets its own workspace and branch, `cobra/<run-id>-<step-id>`.
  - With a single agent step the run keeps `cobra/<run-id>`.

**Navigation (Job 16).** Templates is no longer in the main nav. A top-level **Settings** item (every signed-in team member; last before Admin; highlighted on `/settings/*`) has a sub-tab bar styled like the admin tabs, with one sub-tab for now: Templates at `/settings/templates` (the same `TemplatesView` component, `web/components/templates.tsx`). `/settings` and the old `/templates` URL redirect there. System admins also find it in Admin > Settings > Templates (`/admin?tab=settings&sub=templates`), next to "System settings" (unchanged). Template APIs and "Use template" links (`/workflows/new?template=...`) are unchanged.

**Navigation (Job 17).** Team and Repos moved under Settings too: sub-tabs are Templates, Team, Repos (`/settings/templates`, `/settings/team`, `/settings/repos`), using the same page components (`web/components/team.tsx`, `web/components/repos.tsx`). `/team` and `/repos` redirect with 307 and keep the query string (`next.config.ts`). Access is unchanged (members see Repos read-only; the designated-lead picker stays system-admin-only); API routes are unchanged. Admin > Settings still has only System settings and Templates.

**Prompt limit (Job 18).** Prompts may be up to 20000 characters (was 8000): agent prompts, a workflow's default `prompt` (zod and `workflows/workflow.schema.json`), run prompts, the issue-agent prompt and the run form textarea. Extra instructions stay at 4000.

## Issues and pull requests (approved by Vic, 2026-10-25 6:19 PM ET)

"Admin" here means the system admin only. There is no team-admin role; the team lead does most team work.

Anyone on the team, whether member, team lead or system admin, can create an issue, run an agent that writes the issue, and turn an issue into a pull request, and none of that needs approval. Merging into main is limited to the team's designated team lead and to system admins. Everyone else, including other team leads, can review and comment but can't merge. The app records who did each step.

**Designated lead.** Each team has a designated-lead setting: one person, picked by a system admin, since a team can have more than one team lead. Only that person (plus system admins) can merge into main.

Status: implemented (Job 15, 2026-10-25).

Implementation notes (Job 15):

- **Data (migration 10).** `tenants.designated_lead_user_id` (FK users, SET NULL) and `collab_audit`. An audit row holds actor, action (`issue_create`, `agent_issue`, `pr_create`, `comment` or `merge`), repo, number, run_id, detail and time. A `pr_create` row is written against both the PR and the issue, so it shows on both pages.
- **Pages.**
  - **Issues:** `/issues` lists the team's repos. `/issues/<owner>/<repo>` lists open issues and has two forms: create an issue by hand, or let an agent write one. The issue page `/issues/<owner>/<repo>/<n>` has the body, comments, a comment form, **Create PR** and the audit table.
  - **Pull requests:** the list is `/pulls/<owner>/<repo>`, with open and closed views. The PR page `/pulls/<owner>/<repo>/<n>` has reviews, review comments, comments, a comment form, the **Merge** card and the audit table.
  - **Team settings:** `/team` holds the designated lead.
- **GitHub access.** All calls use the server's `GITHUB_TOKEN` from the env file (`lib/github-api.ts`), and only for the acting team's registered repos (`repoGate`). The API lives under `/api/github/<owner>/<repo>/...` and `/api/team`.
- **Agent-written issue.** This is a pre-approved single run: Claude Code, Codex or a team agent, simulated or real. When the run succeeds, the first line of its output becomes the title (unless one was given) and the rest becomes the body.
- **Create PR.** This is always a **real** run. The agent's prompt carries the issue's title and body plus any extra instructions, and the run pushes `cobra/<run-id>`. Cobra then opens a PR against the repo's default branch with `Closes #<n>`. If nothing was pushed, no PR is opened, and the run log shows why.
- **Merge.** The server enforces it in `mergePull`: only the designated lead (who must still be a team lead) or a system admin (role `admin`) can merge. Everyone else gets 403 and the request never reaches GitHub.
  - Cobra does a plain merge commit pinned to the PR head sha that was shown, never forced.
  - Each merge writes an audit row.
- **Designated lead.** It is chosen at `/team` (`PUT /api/team`) by a system admin only, from the team's team leads, and can be cleared. While none is set, only system admins can merge.
- **Wording.** The UI says "admin" for the system admin. Labels that used to say "team admin" were reworded.
- **Tests.** `web/test/collab.test.ts` covers:
  - members and non-designated leads get 403 on merge;
  - the designated lead and a system admin can merge;
  - every action writes an audit row, scoped per team.
