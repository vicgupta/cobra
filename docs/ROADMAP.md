# Roadmap

## Shipped

- **Scheduled tasks.** User-defined schedules (cron expressions, America/New_York, presets or custom) that run a team agent (optionally with one skill). Enable/disable, Run now, last-run status: see [schedules.md](schedules.md) and Tasks in the app.
- **Task result delivery.** When a scheduled task or Run now finishes, Cobra can email a short summary from the team's mailbox and/or post an in-app notification (header bell). Per-task: on success, on failure, or both. See [schedules.md](schedules.md#result-delivery).

## Future / not scheduled

- **Per-team OS-level isolation.** Run each team's agent steps (checkouts, engines, `.cobra/SOP.md`, secrets) under a separate OS user or container so that one team's runner cannot read another's files. Not implemented; today teams are separated at the app level (team-scoped queries, 404 across teams, per-run workspaces). The app-level boundary is the accepted interim.
