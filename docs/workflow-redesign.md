# Workflow redesign: team repos, team templates, engine and prompt per run

Status: implemented on branch `v1-workflow-redesign` (approved by Vic on 2026-10-25, 4:52 PM ET).

## 1. Per-team GitHub repo registration
- New table `team_repos (tenant_id, repo, default_branch, created_by, created_at)`, unique per (tenant, repo). Every team (tenant) has its own list; there is no global list.
- The migration seeds the default team with `vicgupta/cobra-sandbox` and `vicgupta/factory-demo-app` (default branch `main`).
- Page `/settings/repos` (Settings > Repos; was `/repos` before Job 17). System admins and team leads can add and remove repos; members can only view. API: `GET|POST /api/repos`, `DELETE /api/repos?repo=owner/name`.
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
  - It creates a scratch workspace at `/home/cobra/workspaces/<run-id>`.
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

**Navigation (Job 17).** Team and Repos moved under Settings too: sub-tabs are Templates, Team, Repos (`/settings/templates`, `/settings/team`, `/settings/repos`), using the same page components (`web/components/team.tsx`, `web/components/repos.tsx`). `/team` redirects with 307 and keep the query string (`next.config.ts`). Access is unchanged (members see Repos read-only; the designated-lead picker stays system-admin-only); API routes are unchanged. Admin > Settings still has only System settings and Templates. (Job 31: `/repos` is now the Repos section, see below.)

**Agent description and prompt fields (Job 27).** The Agents page create form now sits at the top and shows, with visible labels: a "What this agent does" description (optional, plain language, max 500 chars, with a counter) and a large required "Prompt / instructions" textarea (resizable, example placeholder, counter against 20000). Before this, the only prompt box was a small unlabeled textarea at the bottom of the page whose placeholder read "What this agent does", so it looked like a short description field. The edit form shows the same two fields. Every agent card shows its description and the prompt in an expandable block (open by default when short), marked read-only for people who can't edit. The description is stored in `team_agents.description` (migration 15), accepted by `POST /api/agents` and `PATCH /api/agents/<name>` as `description` (string or null; empty clears it; omitted keeps it on PATCH) and is **not** part of `content_hash`, so editing it never sends workflows back to pending. Who may create or edit agents is unchanged.

**Prompt limit (Job 18).** Prompts may be up to 20000 characters (was 8000): agent prompts, a workflow's default `prompt` (zod and `workflows/workflow.schema.json`), run prompts, the issue-agent prompt and the run form textarea. Extra instructions stay at 4000.

**Per-repo token (Job 19).** Each team repo may have its own GitHub personal access token (Settings > Repos; set, replace or clear by admins and team leads, members see only "Set ••••abcd" or "—"). It is stored AES-256-GCM encrypted in `team_repos.pat_enc` (migration 11, with `pat_last4` and `pat_set_at`) using `COBRA_SECRET_KEY` (32 random bytes, base64 or hex, in the server env file); without the key saving a token fails with a clear error. On save it is checked with `GET /repos/<repo>` (rejected tokens are not stored; push access is reported). The API only ever returns `patSet` / `patLast4`. When set, the repo's token is used for every GitHub call on that repo (issues, PRs, merge, workflow `github` steps, GitHub file storage, agent clone and push); otherwise `GITHUB_TOKEN`. `COBRA_GITHUB_ALLOWED_REPOS` still applies. Team tokens (and their git auth-header form) are redacted from run logs and errors like env-file secrets.

**One token resolver (Job 20).** `githubTokenFor(tenantId)` in `lib/workflows/server.ts` (built on `tokenFor` in `lib/repos.ts`) is the only place a GitHub token is chosen: the repo's PAT when set, else `GITHUB_TOKEN`. Issues, comments, Create PR, merge, workflow `github` steps, GitHub file storage, the agent clone/push and the agent CLI itself all use it. The agent subprocess (claude or codex) gets exactly that one token as both `GH_TOKEN` and `GITHUB_TOKEN` (plus the git auth header) only when a repo was cloned; never both tokens, none without a repo. A PAT that is set but can't be decrypted (changed `COBRA_SECRET_KEY`) gives no token rather than silently using `GITHUB_TOKEN`. The prompt tells the agent the token is in `$GH_TOKEN` and to use the REST API with curl if `gh` is missing.

## Issues and pull requests (approved by Vic, 2026-10-25 6:19 PM ET)

"Admin" here means the system admin only. There is no team-admin role; the team lead does most team work.

Anyone on the team, whether member, team lead or system admin, can create an issue, run an agent that writes the issue, and turn an issue into a pull request, and none of that needs approval. Merging into main is limited to the team's designated team lead and to system admins. Everyone else, including other team leads, can review and comment but can't merge. The app records who did each step.

**Designated lead.** Each team has a designated-lead setting: one person, picked by a system admin, since a team can have more than one team lead. Only that person (plus system admins) can merge into main.

**Team roles (Job 25, Settings > Team).** Everyone on the team sees the designated lead ("None set" when empty) and a Members table (email, role). Rules, enforced server-side in `web/lib/team.ts` (`PATCH /api/team/members/<id>` with `{ role }` or `{ makeDesignatedLead: true }`; `PUT /api/team` for the picker); anything else gets 403:
- Promote member → team_lead: system admins, and any team lead of the same team.
- Demote team_lead → member: system admins (anyone; demoting the designated lead also unsets the designation). Team leads may demote other team leads of their team, but not themselves and not the current designated lead (that changes merge rights, which stays admin-only).
- Set, change or clear the designated lead, including the one-step "Make designated lead" (promotes a member to team_lead and designates them): system admins only.
- Members: view only. Admin roles are never granted or removed here, user 1 is never changed, other teams are untouched.
- Every change writes a `team_audit` row (migration 13: actor, action `promote` / `demote` / `designate` / `clear_designated`, target, detail, time); admins and leads see recent changes on the page.

Status: implemented (Job 15, 2026-10-25).

Implementation notes (Job 15):

- **Data (migration 10).** `tenants.designated_lead_user_id` (FK users, SET NULL) and `collab_audit`. An audit row holds actor, action (`issue_create`, `agent_issue`, `pr_create`, `comment` or `merge`), repo, number, run_id, detail and time. A `pr_create` row is written against both the PR and the issue, so it shows on both pages.
- **Pages.**
  - **Issues:** `/repos/issues` lists the team's repos. `/repos/issues/<owner>/<repo>` lists open issues and has two forms: create an issue by hand, or let an agent write one. The issue page `/repos/issues/<owner>/<repo>/<n>` has the body, comments, a comment form, **Create PR** and the audit table.
  - **Pull requests:** the list is `/repos/pull-requests/<owner>/<repo>`, with open and closed views. The PR page `/repos/pull-requests/<owner>/<repo>/<n>` has reviews, review comments, comments, a comment form, the **Merge** card and the audit table.
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

### Built-in issue-to-merge workflow (Job 21)

`workflows/issue-to-merge-flow.yaml` (name `issue-to-merge-flow`; `issue-to-merge` is already the system template's name, and names are shared across built-ins and templates) is a built-in (repo) workflow with three `uses: github` steps:
`issue_create` (inputs `title`, `body`) -> `pr_from_issue` (runs the run's engine, claude-code or
codex with the per-run override, on the issue, pushes `cobra/<run-id>`, and opens a PR whose body starts
`Closes #<issue>`) -> `merge` (plain merge pinned to the PR's head sha, never forced). Every GitHub call
goes through the Job 20 resolver (the repo's PAT, else GITHUB_TOKEN). Each step writes a `collab_audit`
row (`issue_create`, `pr_create`, `merge`) as the person who started the run. The merge step enforces
the merge rule: unless the starter is the team's designated lead or a system admin, it fails with
"merge not allowed: ... PR #n is left open", even in simulated mode. Simulated runs call neither GitHub nor an
agent. Like every workflow, it must be approved before it runs. The `issue-to-merge` system template is unchanged.

**Per-agent model (Job 23).** `team_agents.model` (migration 12, NULL = the engine's default). The Agents form has a Model select per engine (plus Default); the card and the run header show it: `[agent] name @ hash (engine, model, mode)`. Real runs pass `--model <id>` to `claude -p` and `-m <id>` to `codex exec`. Allowed ids live in `web/lib/agent-models.ts` (sources and date noted there; `COBRA_CLAUDE_MODELS` / `COBRA_CODEX_MODELS` override, comma-separated); anything else is a 400. The model is folded into the agent hash (unchanged when Default, so existing approvals stay valid).

## Settings > Providers (requested by Vic, 2026-10-25 7:58 PM ET)

A Settings sub-tab after Docs (not in the top nav). It lists the coding agents Cobra really runs (`AGENT_ENGINES` in `web/lib/agents.ts`): **Claude Code** (`claude -p`, 2.1.310) and **Codex** (`codex exec`, 0.164.0). "Simulated" is a run mode in which no CLI executes, so it is not listed as a provider.

| Provider | Models (`web/lib/agent-models.ts`, env override) | Effort tiers offered | How passed |
|---|---|---|---|
| Claude Code | sonnet, opus, haiku, fable, claude-sonnet-5-5, claude-opus-5-5, claude-haiku-5-5, claude-fable-5-1 (`COBRA_CLAUDE_MODELS`) | low / medium / high | `--model <id>`, `--effort <tier>` |
| Codex | gpt-6.1-sol, gpt-6-sol, gpt-6-astra, gpt-6-luna, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna (`COBRA_CODEX_MODELS`) | low / medium / high | `-m <id>`, `-c model_reasoning_effort="<tier>"` |

Verified on nova: `claude --help` lists `--effort <level>` (low, medium, high, xhigh, max). `codex exec --help` has no effort flag; `-c, --config <key=value>` overrides `~/.codex/config.toml`, and the key is `model_reasoning_effort` (every listed model in `~/.codex/models_cache.json` supports low…max, some also ultra). Cobra offers the three tiers both accept for every model. A provider without tiers would show "Not supported".

Configuration (`web/lib/providers.ts`, `PUT /api/providers/<engine>` with `{ model?, effort? }`, `"default"`/null clears): system admins only (403 otherwise); models are validated against the provider's list and tiers against low/medium/high (400). Stored in `provider_defaults` (migration 14), every change audited in `provider_audit` and shown to admins on the page. At run time (`localRunner` `providerDefaults`) an agent with no model uses the provider default model (the agent's own model wins) and the default tier is passed as the flag; the run log says `model: X (provider default), effort: Y`. Defaults are not in the agent hash, so existing hashes and workflow approvals are unchanged.

**Repos section (Job 31).** The main nav is Dashboard, Workflows, Agents, Repos, Settings (+ Admin for system admins); Issues and Pull requests are no longer separate items. Repos (`/repos/*`, `web/app/repos/layout.tsx`) uses the same tab bar as Settings (`web/components/tabs.tsx`, shared by `settings-tabs.tsx` and `repos-tabs.tsx`). Tabs:
- **Overview** (`/repos/overview`; `/repos` goes here): one card per team repo with the default branch, whether a repo PAT is set (never the token), open issue and PR counts (GitHub, per-repo token resolver), and the last Cobra run on it. Admins and team leads get a link to Settings > Repos.
- **Issues** (`/repos/issues`, `/repos/issues/<owner>/<repo>[/<n>]`) and **Pull Requests** (`/repos/pull-requests`, `/repos/pull-requests/<owner>/<repo>[/<n>]`): the former Issues and PR pages, unchanged.
- **Branches** (`/repos/branches[?repo=owner/name]`, API `GET /api/repos/branches[?repo=]`): read-only branch list of every repo on the team's list (whoever added it); system admins also see other teams' repos. Cobra-specific branches are system-only and hidden from every role, server-side: all branches of `vicgupta/cobra` (403) and every `cobra/*` working branch on any repo. Repos outside the list give 404. The runner, PR creation and merge still use `cobra/<run-id>` as before.
- **Activity** (`/repos/activity[?repo=]`): Cobra's audited issue/PR/comment/merge actions (`collab_audit`), runs and finished steps (`runs`, `run_step_events`) for the team's repos, newest first.

Redirects (307, query string kept, `next.config.ts`): `/repos` → `/repos/overview`, `/issues/*` → `/repos/issues/*`, `/pulls/*` → `/repos/pull-requests/*`. The repo list and PATs stay at `/settings/repos`.
