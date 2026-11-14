# Roadmap

## Shipped

- **Scheduled tasks.** User-defined schedules (cron expressions, America/New_York, presets or custom) that run a team agent (optionally with one skill). Enable/disable, Run now, last-run status: see [schedules.md](schedules.md) and Tasks in the app.
- **Automation library.** Five editable engineering packs (morning PR/issue brief, stale PRs, CI digest, review follow-up, weekly repo health) on the Tasks page Templates tab, grouped into category pills — Engineering, Finance, Human Resources, Productivity (data in `task_templates`, migration 40). Confirm creates a skill + task and returns you to Current with the new task highlighted. New templates can be added on nova without a redeploy. See [automation-library.md](automation-library.md).
- **Task result delivery.** When a scheduled task or Run now finishes, Cobra can email a short summary from the team's mailbox and/or post an in-app notification (header bell). Per-task: on success, on failure, or both. See [schedules.md](schedules.md#result-delivery).

## Future / not scheduled

- **Per-team OS-level isolation.** Run each team's agent steps (checkouts, engines, `.cobra/SOP.md`, secrets) under a separate OS user or container so that one team's runner cannot read another's files. Not implemented; today teams are separated at the app level (team-scoped queries, 404 across teams, per-run workspaces). The app-level boundary is the accepted interim.
