# Admin dashboard

- Gate: `COBRA_ADMIN_EMAIL` in the server env file (`COBRA_ENV_FILE`), read fresh on every request with no restart and no `process.env` fallback. It is a case-insensitive exact match on the signed-in email. Blank, missing or an unreadable file means nobody is the admin.
- Enforced in `proxy.ts` with real HTTP statuses, and again in `requireUser`/`requireAdmin`/`apiGuard` (`lib/admin/gate.ts`):
  - The admin account: every regular page → 307 `/admin`, every regular API → 403. Only `/admin`, `/api/admin/*` and logout work.
  - Everyone else: `/admin` and `/api/admin/*` → 404.
- `/admin?tab=` shows overview | tenants | users | sessions | workflows | logs | approvals | rate-limits | settings. It is read-only except Settings (agent keys and the GitHub token, written to the env file via `/api/admin/settings`) and ending a session (`DELETE /api/admin/sessions/<public id>`).
- The old `/settings` page and `/api/settings` are gone.
