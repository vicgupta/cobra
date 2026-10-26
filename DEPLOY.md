# Deploying Cobra to nova

- `ssh nova`; app dir: `systemctl show -p WorkingDirectory --value cobra-web` (`/home/cobra/cobra/web`), checkout on branch `v1-workflow-redesign`, owned by `cobra`.
- Before deploying: in `web/` with Node 24, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` must pass.
- Back up the DB first (mode 600): there is no sqlite3 CLI on nova, so use node:sqlite: `sudo -u cobra node -e 'const s=require("node:sqlite");s.backup(new s.DatabaseSync("/var/lib/cobra/cobra.db"),process.argv[1])' /var/lib/cobra/cobra.db.bak-<job> && sudo chmod 600 /var/lib/cobra/cobra.db.bak-<job>`. Migrations run when the app first opens the DB after restart.
- Deploy: `cd /home/cobra/cobra && sudo -u cobra git pull --ff-only`, then in `web/`: `sudo -u cobra npm ci` (if deps changed) and `sudo -u cobra npm run build`, then `sudo systemctl restart cobra-web`. Migrations run on first DB open.
- Never print values from `/etc/cobra/cobra.env`. DB and logs are UTC.

## Notes

- **OpenCode + Cursor engines (migration 18).** Rebuilds `team_agents` and `provider_defaults` to widen the engine CHECK (data copied as is), adds `provider_secrets` and `provider_audit.detail`. Back up the DB first. CLIs as the cobra user into ~/.local/bin (already on the service PATH): `npm i -g --prefix ~/.local opencode-ai` and `curl https://cursor.com/install -fsS | bash`. OpenCode reuses the Codex login; Cursor needs a system admin to set CURSOR_API_KEY on the Cursor row of Settings > Providers.
- **Providers (Settings > Providers, migration 14).** Adds `provider_defaults` and `provider_audit`. Empty tables mean no behavior change: runs pass no extra flags until a system admin sets a default model or effort tier. Effort flags: `claude --effort <tier>`, `codex exec -c model_reasoning_effort="<tier>"`; if a CLI upgrade drops these, clear the effort defaults on the page. Agent hashes and workflow approvals are unaffected.
- **Run history (migration 16).** Adds `runs.triggered_by` (backfilled from `created_by` emails, else `unknown`) and an index on `runs(workflow, started_at)`. Read-only feature; back up the DB first as above.
- **Usage (migration 19).** Adds `run_usage` (per agent step: provider, model, input/output/cached tokens, `cost_usd` only when the engine reports it, `cost_source`). Claude Code now runs with `--output-format json` and Codex with `exec --json` (tokens only); OpenCode/Cursor steps get a row with null tokens/cost; the runner parses usage at the end of the step and logs the readable text. Settings > Usage (own team; system admins all teams) and Admin > Usage (all teams) are display only (no budgets or limits). Back up the DB first as above.
