# Admin dashboard

- Gate: `COBRA_ADMIN_EMAIL` in the server env file (`COBRA_ENV_FILE`), read fresh on every request with no restart and no `process.env` fallback. It is a case-insensitive exact match on the signed-in email. Blank, missing or an unreadable file means nobody is the admin.
- The admin account keeps the full regular app (workflows, templates, runs, logs) and also gets `/admin`, with an Admin link in the nav visible only to it.
- Everyone else gets 404 on `/admin` and `/api/admin/*`, enforced in `proxy.ts` with a real status and again in `requireAdmin`/`apiGuard` (`lib/admin/gate.ts`).
- `/admin?tab=` shows overview | tenants | users | sessions | workflows | logs | approvals | rate-limits | settings. It is read-only except Settings (agent keys and the GitHub token, written to the env file via `/api/admin/settings`) and ending a session (`DELETE /api/admin/sessions/<public id>`).
- The old `/settings` page and `/api/settings` are gone.

## Self-serve registration

People can join Cobra in three ways. Each one is bound to an email address, and every step is recorded in the team's audit log (Settings > Team).

- **Invites (magic links).** Team leads (for their own team) and system admins can invite people from Settings > Team > *Invite people*.
  - The link is single-use and expires in 7 days. Only a sha256 hash is stored.
  - It works only for the invited email and is listed on the page, where it can be revoked.
  - Invitees join as **member**. Only a system admin can invite someone as a **team lead**.
  - The invitee opens `/register?invite=…`, sees "Join <team>" with their email locked, and sets their name and a password (at least 10 characters). The account is created and they are signed in.
  - Audit: `invite_create`, `invite_revoke`, `invite_accept`.
- **Create a new team** (`/register`). The person enters email, name, password and team name.
  - Nothing is created until they confirm a one-time email link, which expires after 24 hours. The confirm page uses a button, so mail scanners can't consume the link.
  - When they confirm, a new team is created with a unique slug derived from its name. The creator becomes its **team lead and designated lead**, never a system admin.
  - The team workspace directory is created on first run.
  - Audit: `team_create`, `designate`.
- **Join an existing team** (`/register?mode=join`). The person enters email, name, and the team's exact name or slug. There is no public team list.
  - After they confirm their email, a *pending* join request is created and the team's leads (plus the designated lead) get an email.
  - A lead or admin then picks **Send magic link** (a member invite, as above) or **Dismiss** under Settings > Team > *Join requests*.
  - Requests nobody answers expire after 14 days.
  - Audit: `join_request`, `join_notify`, `join_send_link`, `join_dismiss`, `join_expire`, and `invite_accept`.

**Safety**
- Public responses never reveal whether an email has an account or whether a team exists. Join requests always get "If that team exists, its lead will be notified". If an existing account signs up again, they get an "you already have an account" email.
- All POST routes check Origin.
- DB-backed rate limits:
  - 10 sign-up or invite-accept submissions per IP per 15 min (429).
  - 3 verification emails per address per 15 min (silent).
  - 20 confirmations per IP per 15 min.
  - 30 invites or magic links per lead per hour.
- Caps: at most 5 open verifications per email, 3 pending join requests per email, and 25 per team. Anything over a cap is silently dropped.
- **Allow new team sign-ups** (Settings > Team > *Sign-ups*, system admins only, audited as `signup_toggle`) is on by default. Turning it off disables *Create a new team* only. Invites and join requests keep working.
- Existing accounts are untouched, and `scripts/user.mts` still creates users directly.
- All system emails (password resets, sign-up verification, invites, magic links, join links, notifications) are sent from `danny@kantsy.com` via the Kantsy API; `COBRA_MAIL_FROM` in the server env file overrides it.
- For local testing, `COBRA_MAIL_OUTBOX=/path/file.jsonl` writes emails to a file instead of sending them. Never set it on production. `COBRA_PUBLIC_URL` sets the link base (default `https://nova.kantsy.com`).

## Agent tool updates (Settings > Updates)

Every day at **4:00 AM America/New_York** (DST-aware) Cobra updates the agent CLIs on the server as the service user (`cobra`) and snapshots the model catalogs. Toggle it in **Settings > Updates** (system admins only, default on); every toggle and "Run update now" is audited.

- **Claude Code, Codex, OpenCode** (npm global prefix `~/.local`): `npm i -g --prefix ~/.local/share/cobra-updates/<tool>-XXXX <pkg>@latest` into a staging prefix, smoke-tested with `--version`, then swapped in by an atomic rename. The previous package is kept as `<pkg>.cobra-prev`; if the swapped-in binary fails `--version`, the previous one is renamed back and the row is marked **rolled back**. A failed staged install never touches the live install.
- **Cursor agent**: the official installer (`cursor.com/install`) adds a new versioned directory; if the new `cursor-agent --version` fails, the `cursor-agent`/`agent` links are atomically repointed to the previous version.
- **Catalogs**: OpenCode Zen (`opencode models opencode --refresh`), Codex (`~/.codex/models_cache.json`, read only), Cursor (only when `CURSOR_API_KEY` is set). OpenRouter is **on hold** and not refreshed.
- If an agent run is active, the update retries every 15 minutes until 6:30 AM ET, then is skipped and recorded. If the server was down at 4 AM it catches up the same day.
- The page shows each run as a before/after table (Before, After, changed / unchanged / rolled back / failed, time) with a history of past runs; the 7 AM admin email includes last night's results.
- Disable the timer with `COBRA_UPDATE_SCHEDULER=off`. Commands run with a minimal environment (no Cobra secrets) and output is redacted.

## Team notifications (Settings > Team notifications)

Each team gets its own daily email at **7:00 AM America/New_York** (DST-aware, one send per team per day, catch-up until noon ET). It covers **only that team's last 24 hours**: runs by status, engine and provider; failures with links; token usage and engine-reported spend; skills and workflows changed or awaiting approval; issues, PRs and merges; join requests and invites; new members; team audit highlights. No server health, other teams or admin metrics.

- **On by default** for every team. **Recipients:** `Team leads` (team leads and the designated lead, default) or `Entire team` (every member). The tab shows the resolved list.
- Team leads and system admins change the toggle and recipients and can "Send test now" (emails only the person clicking). Members see the tab and can opt out of their own copy.
- Skipped days (disabled, or nobody left after opt-outs) are recorded with the reason. Every change is in team_audit (`notify_*`).
- The system-admin email is unchanged (MVP has no Settings > Notifications UI; it uses the stored setting).
