# Roadmap

## Future / not scheduled

- **Per-team OS-level isolation.** Run each team's agent steps (checkouts, engines, `.cobra/SOP.md`, secrets) under a separate OS user or container so that one team's runner cannot read another's files. Not implemented; today teams are separated at the app level (team-scoped queries, 404 across teams, per-run workspaces). The app-level boundary is the accepted interim.
