# Deploying Cobra to nova

- `ssh nova`; app dir: `systemctl show -p WorkingDirectory --value cobra-web` (`/home/cobra/cobra/web`), checkout on branch `v1-workflow-redesign`, owned by `cobra`.
- Before deploying: in `web/` with Node 24, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` must pass.
- Back up the DB first (mode 600): `sudo -u cobra sqlite3 /var/lib/cobra/cobra.db ".backup /var/lib/cobra/cobra.db.bak-<job>" && sudo chmod 600 /var/lib/cobra/cobra.db.bak-<job>`.
- Deploy: `cd /home/cobra/cobra && sudo -u cobra git pull --ff-only`, then in `web/`: `sudo -u cobra npm ci` (if deps changed) and `sudo -u cobra npm run build`, then `sudo systemctl restart cobra-web`. Migrations run on first DB open.
- Never print values from `/etc/cobra/cobra.env`. DB and logs are UTC.

## Notes

- **Providers (Settings > Providers, migration 14).** Adds `provider_defaults` and `provider_audit`. Empty tables mean no behavior change: runs pass no extra flags until a system admin sets a default model or effort tier. Effort flags: `claude --effort <tier>`, `codex exec -c model_reasoning_effort="<tier>"`; if a CLI upgrade drops these, clear the effort defaults on the page. Agent hashes and workflow approvals are unaffected.
