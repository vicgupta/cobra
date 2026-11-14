# Automation library

The Tasks page has two tabs: **Current** (your tasks, the default) and **Templates** (the **automation library**). Templates lists ready-made engineering packs, filtered by category pills (All plus each category). The active category is URL-addressable, for example `/tasks?tab=templates&category=engineering`. Templates added in the last 7 days show a **New** badge.

Each pack is a starting point — a prefilled skill, a suggested Eastern-time schedule, and suggested result delivery. You pick the repo and the agent, you can edit everything, and a confirm step creates the skill and the task. After you confirm, Cobra takes you back to Current and highlights the new task (`/tasks?tab=current&task=<id>`).

Categories live in one list (`TEMPLATE_CATEGORIES` in `web/lib/task-templates.ts`) so more can be added later. To start: Engineering, Finance, Human Resources, Productivity (`engineering`, `finance`, `human-resources`, `productivity`).

The original five packs:

| Pack | Category | Suggested schedule (ET) |
|---|---|---|
| Morning PR & issue brief | Engineering | Weekdays at 9:00 AM |
| Stale PR reminder | Engineering | Weekdays at 10:00 AM |
| CI failure digest | Engineering | Weekdays at 8:00 AM |
| Unanswered review follow-up | Engineering | Weekdays at 11:00 AM |
| Weekly repo health | Engineering | Mondays at 9:00 AM |

Default run type is a **test run** (nothing is posted or changed). Switch to a real run on the form or later in the task if you want the agent to comment or open work. Delivery defaults to an in-app notification on success or failure (email if you turn it on and the team has a mailbox).

The catalog is **data**, not code: rows in the global `task_templates` table (migration 40, `PRAGMA user_version` 40; the table itself was added in 39). Templates are not team-scoped. Activation is `POST /api/automation-library` (sign-in required). If creating the task fails, the new skill is not kept.

## Adding a template (no redeploy)

On nova, as `cobra`, from the web app directory, point at the production database and pass a JSON file (see `web/scripts/examples/task-template.json`). The insert is idempotent by `slug`: a second run with the same content exits 0 and does nothing. If the slug exists with different content, the command refuses unless you pass `--update` (that keeps the original `created_at`).

```bash
cd /home/cobra/cobra/web
COBRA_DB_PATH=/var/lib/cobra/cobra.db npm run template:add -- --file /path/to/template.json
```

Required fields: `slug` (or a slug-shaped `name`), `name`, `category` (one of the slugs above, e.g. `engineering` or the label `Human Resources`), `description`, `skillBody` (prompt/steps; `prompt` or `steps` also accepted), `cron`. Optional: `skillName`, `skillDescription`, `taskName`, `scheduleLabel` (filled in from the cron if omitted), `notifyOn` / `notifyInApp` / `notifyEmail` (or a `delivery` object), `mode` (`simulated` by default), `createdAt`.
