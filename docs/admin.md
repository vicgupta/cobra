# Admin dashboard

- Gate: `COBRA_ADMIN_EMAIL` in the server env file (`COBRA_ENV_FILE`), read fresh on every request with no restart and no `process.env` fallback. It is a case-insensitive exact match on the signed-in email. Blank, missing or an unreadable file means nobody is the admin.
- The admin account keeps the full regular app (workflows, templates, runs, logs) and also gets `/admin`, with an Admin link in the nav visible only to it.
- Everyone else gets 404 on `/admin` and `/api/admin/*`, enforced in `proxy.ts` with a real status and again in `requireAdmin`/`apiGuard` (`lib/admin/gate.ts`).
- `/admin?tab=` shows overview | tenants | users | sessions | workflows | logs | approvals | rate-limits | settings. It is read-only except Settings (agent keys and the GitHub token, written to the env file via `/api/admin/settings`) and ending a session (`DELETE /api/admin/sessions/<public id>`).
- The old `/settings` page and `/api/settings` are gone.
