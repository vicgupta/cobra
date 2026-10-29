# Cobra Team API (v1)

The Team API lets scripts and CI create and run a team's skills and agents without a browser session. It is **confined to one team and one repo per key**.

- Base path: `/api/v1/teams/{teamId}/repos/{repoId}`
- Auth: `Authorization: Bearer <API_KEY>`
- Format: JSON in, JSON out (`content-type: application/json`), bodies up to 512 KB.

In the examples, `$COBRA`, `$TEAM`, `$REPO` and `$KEY` are placeholders, e.g. `COBRA=https://cobra.example.com`. Never paste a real key into docs, tickets or chat.

## Team confinement model

- A key belongs to exactly **one team and one team repo**. The `{teamId}` and `{repoId}` in the path must match the key, or you get **403**.
- Skills and agents are team objects. Through the API, a key sees **only the skills and agents created with a key for the same team and repo**. Objects made in the UI, or through another repo's key, return **404** (they are never revealed).
- Agents created through the API always get `defaultRepo` = the key's repo. Any other `defaultRepo` returns **400**. An agent's `skillId` must be a skill the key can see (otherwise **404**).
- Every run started through the API runs against the key's repo. Only runs created through the API are addressable.
- A system admin has no bypass. Admins follow the same rules.


### Check your key: `GET /api/v1/teams/{teamId}/repos/{repoId}`

The bare base path returns the key's team, repo and endpoints. Use it as a first "does my key work?" call:

```bash
curl -H "Authorization: Bearer $KEY" https://nova.kantsy.com/api/v1/teams/2/repos/1
# {"ok":true,"team":{"id":2,"name":"..."},"repo":{"id":1,"name":"owner/repo"},"key":{"id":1,"prefix":"cbk_..."},"endpoints":[...]}
```

`teamId` and `repoId` are numeric ids, not names. Settings → API keys shows each key's full base URL. If you get a 403, the error message tells you which base path the key is valid for.

## Keys

### Generate (team leads only)
1. Sign in as the team lead or the team's designated lead.
2. Open **Settings → API keys** (`/settings/api-keys`).
3. Enter a name (1–80 characters), pick the repo, then click **Generate key**.
4. Copy the key from the yellow box. **It is shown once.** Cobra stores only a SHA-256 hash and a 12-character display prefix (`cbk_xxxxxxxx…`).

Members can see the key list (name, prefix, repo, creator, created, last used, status) but cannot create or revoke keys (403). A key stops working (401) if its creator is no longer a lead of the team. Removing a repo from the team deletes that repo's keys.

### Revoke
In **Settings → API keys**, click **Revoke** next to the key and confirm. From then on, every call with that key gets **401**. Revoked keys stay in the list, marked as revoked.

### Key format
`cbk_` followed by 43 URL-safe base64 characters.

## Errors

All errors look like this:

```json
{ "error": "human readable message" }
```

| Status | When |
|---|---|
| 400 | Invalid body or field (the message names the field) |
| 401 | Missing, malformed, invalid or revoked key, or the key's creator is no longer a lead |
| 403 | The key is valid but `{teamId}`/`{repoId}` in the path are not the key's |
| 404 | Unknown path, or an object outside the key's team and repo |
| 405 | Method not allowed. The `Allow` header lists the allowed methods. `DELETE` on runs is always 405 |
| 409 | State conflict (e.g. changing the prompt of a started run, or a skill still in use) |
| 413 | Body larger than 512 KB |
| 429 | Rate limited (see below) |

The checks run in this order: key (401), then team/repo (403), then the rate limit (429), then the object (404) and method (405).

## Rate limits
These use Cobra's database rate limiter:
- 30 failed key attempts per IP per 15 minutes, then 429
- 120 requests per key per minute
- 60 run starts per key per hour (covers `POST /runs`, `/start`, `/instantiate`, and the `/run` shortcuts)

## Audit
- Every non-GET call is written to `api_audit` with the key id, method, target and result status, including failed calls.
- Skill changes are also written to the skill audit, with actor `api-key:<keyId>`.
- Agent changes are also written to the agent audit (`api_agent_create`, `api_agent_update`, `api_agent_delete`), with the key id.
- Key creation and revocation are audited (`key_create`, `key_revoke`).
- Keys are never logged.

## Objects

**Skill**
```json
{ "id": 12, "name": "deploy-notes", "description": "Write deploy notes", "kind": "sop", "body": "# Notes\n\n## Write\nWrite the notes.", "plan": { "steps": [] }, "version": 1, "createdAt": 1793280000000, "updatedAt": 1793280000000 }
```

**Agent**
```json
{ "id": 3, "name": "builder", "engine": "claude-code", "model": null, "description": "", "prompt": "Build it.", "defaultRepo": "acme/api", "kind": "prompt", "skillRef": null }
```

**Run**
```json
{ "id": "apr_mh3k2x1a9f3c2b1d", "status": "started", "kind": "agent", "ref": 3, "prompt": "Fix the flaky test", "mode": "simulated",
  "meta": { "ticket": "OPS-12" }, "rerunOf": null, "runId": "run_abc123", "url": "/runs/run_abc123",
  "run": { "status": "running", "startedAt": 1793280000000, "endedAt": null, "error": null, "mode": "simulated" },
  "injectedLessons": [41, 42], "createdAt": 1793280000000, "updatedAt": 1793280000000 }
```
- `status` is the API record's status: `pending`, `started` or `cancelled`.
- `run.status` is the live status of the Cobra run.
- `{id}` in run paths can be the `apr_…` id or the `runId`.

## Endpoints

| Method | Path | Success |
|---|---|---|
| GET | `/skills` | 200 `{skills: Skill[]}` |
| POST | `/skills` | 201 `{skill}` |
| GET | `/skills/{id}` | 200 `{skill}` |
| PUT | `/skills/{id}` | 200 `{skill}` |
| DELETE | `/skills/{id}` | 200 `{ok: true}` |
| POST | `/skills/{id}/run` | 201 `{run}` |
| GET | `/agents` | 200 `{agents: Agent[]}` |
| POST | `/agents` | 201 `{agent}` |
| GET | `/agents/{id}` | 200 `{agent}` |
| PUT | `/agents/{id}` | 200 `{agent}` |
| DELETE | `/agents/{id}` | 200 `{ok: true}` |
| POST | `/agents/{id}/run` | 201 `{run}` |
| GET | `/runs` | 200 `{runs: Run[]}` (newest 100) |
| POST | `/runs` | 201 `{run}` |
| GET | `/runs/{id}` | 200 `{run}` |
| PUT | `/runs/{id}` | 200 `{run}` |
| DELETE | `/runs/{id}` | always 405 |
| POST | `/runs/{id}/start` | 201 `{run}` |
| POST | `/runs/{id}/instantiate` | 201 `{run}` (alias of start) |

All paths are relative to the base path. Setup for the examples:

```bash
COBRA=https://cobra.example.com TEAM=1 REPO=2 KEY=cbk_REPLACE_ME
BASE=$COBRA/api/v1/teams/$TEAM/repos/$REPO
```

### GET /skills
Lists the skills this key can see.
```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/skills
```
Returns 200 `{"skills":[Skill…]}`.

### POST /skills
Request: `{ name: string (lowercase-dash, ≤63, required), description: string (required), body?: string (markdown; "##" headings become steps), plan?: {steps: […]}, kind?: "sop" }`. These are the same validation rules as the UI.
```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"name":"deploy-notes","description":"Write deploy notes","body":"# Notes\n\n## Write\nWrite the notes."}' $BASE/skills
```
Returns 201 `{"skill":Skill}`. Errors: 400 (validation), 409 (name taken).

### GET /skills/{id}
```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/skills/12
```
Returns 200 `{"skill":Skill}`, or 404.

### PUT /skills/{id}
Same fields as create, all optional. Fields you leave out keep their values.
```bash
curl -s -X PUT -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"description":"Updated"}' $BASE/skills/12
```
Returns 200 `{"skill":Skill}`. Errors: 400, 404.

### DELETE /skills/{id}
```bash
curl -s -X DELETE -H "Authorization: Bearer $KEY" $BASE/skills/12
```
Returns 200 `{"ok":true}`. Errors: 404, or 409 if an agent, task or skill still uses it. Past runs are kept.

### POST /skills/{id}/run
Shortcut for `POST /runs {"skillId": id}`. Body: `{ prompt?, mode?, meta? }`.
```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"prompt":"Notes for v1.4"}' $BASE/skills/12/run
```

### GET /agents
```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/agents
```

### POST /agents
Request: `{ name: string (required), engine: "claude-code"|"codex"|… (required), prompt: string (required), model?, description?, kind?, skillId?: number | skillRef?: "sop:<id>", cron?, cronEnabled?, cronMode? }`. `defaultRepo` is always the key's repo. `sourceUrl` is ignored.
```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"name":"builder","engine":"claude-code","prompt":"Build it."}' $BASE/agents
```
Returns 201 `{"agent":Agent}`. Errors: 400, 404 (skill not visible), 409 (name taken).

### GET /agents/{id}
```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/agents/3
```

### PUT /agents/{id}
```bash
curl -s -X PUT -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"prompt":"Build it carefully."}' $BASE/agents/3
```

### DELETE /agents/{id}
Soft delete: past runs stay.
```bash
curl -s -X DELETE -H "Authorization: Bearer $KEY" $BASE/agents/3
```

### POST /agents/{id}/run
Shortcut for `POST /runs {"agentId": id}`.
```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"prompt":"Fix the flaky test"}' $BASE/agents/3/run
```

### GET /runs
```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/runs
```

### POST /runs — create and instantiate a run
Request:
```
{ skillId?: number, agentId?: number, engine?: string,   // exactly one target; engine needs a prompt
  prompt?: string (≤4000), mode?: "simulated" | "real" (default "simulated"),
  meta?: object (≤4000 chars as JSON), start?: boolean (default true) }
```
- The run goes through the same path as the UI, so the launcher, run users, and lesson injection and capture all apply.
- `engine` is not allowed with `skillId`. With `agentId`, it must match the agent's engine.
- `start:false` saves a pending run that you can start later.
```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"agentId":3,"prompt":"Fix the flaky test","mode":"real","meta":{"ticket":"OPS-12"}}' $BASE/runs
```
Returns 201 `{"run":Run}`. Errors: 400, 404 (skill or agent not visible), 429.

### GET /runs/{id}
```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/runs/apr_mh3k2x1a9f3c2b1d
```

### PUT /runs/{id}
Request: `{ meta?: object, prompt?, mode?, cancel?: true }`.
- `meta` can change at any time.
- `prompt` and `mode` can change only while the run is pending (409 otherwise).
- `cancel` works only on pending runs. A started run can't be cancelled through the API (409).
```bash
curl -s -X PUT -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{"meta":{"ticket":"OPS-13"}}' $BASE/runs/apr_mh3k2x1a9f3c2b1d
```

### DELETE /runs/{id}
Runs are history and are never deleted. This always returns 405 with `Allow: GET, PUT`.
```bash
curl -si -X DELETE -H "Authorization: Bearer $KEY" $BASE/runs/apr_mh3k2x1a9f3c2b1d   # 405
```

### POST /runs/{id}/start (alias /instantiate)
- A **pending** run starts in place (same id).
- A **started or cancelled** run is re-instantiated as a **new** run, with a new `id` and `runId` and `rerunOf` set to the old id. The old run is not changed.
- The optional body `{prompt?, mode?, meta?}` overrides the old values for the new run.
```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{}' $BASE/runs/apr_mh3k2x1a9f3c2b1d/start
curl -s -X POST -H "Authorization: Bearer $KEY" -H "content-type: application/json" -d '{}' $BASE/runs/apr_mh3k2x1a9f3c2b1d/instantiate
```

## How lessons apply to API runs
API runs go through the same service functions as UI runs (skill run, team agent run, direct engine run). So:
- **Injection:** approved team lessons for the key's repo are added to the run's prompt, exactly as for a UI run. The run's `injectedLessons` lists their ids.
- **Capture:** when the run finishes, the runner's lesson capture records failures and fixes for the team as usual. Captured lessons wait for a lead's review.
- Lessons from other teams or repos are never injected.

## Changelog
- **2026-10-29: v1.** Team API keys (lead-generated in Settings → API keys, hashed, one team and one repo per key, revocable, last-used tracking). Skills and agents CRUD, run creation and instantiation (`/runs`, `/runs/{id}/start|instantiate`, `/skills/{id}/run`, `/agents/{id}/run`), audit with the key id, DB rate limits. Docs are at `/docs/api` (sign-in required).
