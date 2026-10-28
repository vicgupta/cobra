# Cobra run launcher (per-team run users)

Agent steps (Claude Code, Codex, and the git commands around them) run as one Linux user **per team**,
`cobra-run-<tenantId>`, never as `cobra` (the web app). The web app has no sudo; it asks this small root daemon.

| Piece | Where (nova) |
|---|---|
| `launcher.py` (root daemon, ~275 lines) | `/usr/local/lib/cobra-launcher/launcher.py` (root:root 0755), unit `cobra-launcher.service` |
| `stage.py` (runs inside the unit as the team user) | `/usr/local/lib/cobra-launcher/stage.py` |
| Socket | `/run/cobra-launcher.sock`, root:cobra 0660, and the daemon also checks SO_PEERCRED uid == cobra |
| Team dirs (= run user's HOME; workspaces, `~/.claude`, `~/.codex`) | `/srv/cobra-teams/<id>`, 0700, owned by `cobra-run-<id>` |
| Agent CLIs (claude, codex, opencode) | `/opt/cobra-tools` (owned by cobra, 0755; run users can execute, not modify; the 4 AM updater updates it via `COBRA_NPM_TOOLS_PREFIX`) |
| cobra-web drop-in | `/etc/systemd/system/cobra-web.service.d/zz-run-users.conf` (`COBRA_LAUNCHER_SOCKET`, `COBRA_TEAMS_ROOT`, ...) |

**Request** (one JSON line per connection): `tenantId` (positive int, must exist in `tenants`), `runId`
(`[A-Za-z0-9_-]{1,128}`), `engine` ∈ {claude-code, codex, git} (mapped to fixed binaries), `args` (array; no shell),
`env` (allowlist only: GIT_* auth header config, GH_TOKEN/GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
CODEX_API_KEY, CODEX_HOME inside the workspace), `workspace` (must be exactly `<teams>/<id>/workspaces/<runId>`),
`timeoutSec`, optional `mkdir`, `files` (pre-run writes), `readBack`, `rmAfter` (workspace-relative, no `..`).
**Response**: `{"t":"o","d":...}` output frames (stdout+stderr), then `{"t":"x","code":N,"files":{...}}`, or
`{"t":"e","error":...}`. Closing the connection (cancel/timeout in Cobra) stops the unit (SIGKILL to the cgroup).

**Unit** (`systemd-run --pipe --wait`, transient `cobra-run-<id>-<runId>-<rand>`): `--uid/--gid=cobra-run-<id>`,
NoNewPrivileges, empty CapabilityBoundingSet/AmbientCapabilities, ProtectSystem=strict, ProtectHome=yes, PrivateTmp,
PrivateDevices, ProtectProc=invisible, Protect{KernelTunables,KernelModules,KernelLogs,ControlGroups,Clock,Hostname},
RestrictSUIDSGID, `TemporaryFileSystem=/srv/cobra-teams:ro` + `BindPaths/ReadWritePaths=<team dir>` (other teams
invisible), InaccessiblePaths=/etc/cobra /var/lib/cobra /home/cobra /root /run/cobra-launcher.sock,
MemoryMax=3G, CPUQuota=200%, TasksMax=512, RuntimeMaxSec=<run timeout>.
Prompts, tokens and file contents go over the unit's stdin, never into argv or unit properties (which any local user
can read with `systemctl show`); the journal gets only unit name, engine, timeout and exit code.

**New teams**: on the first step for a tenant id that exists in the DB, the launcher creates `cobra-run-<id>`
(`useradd --system --user-group --shell /usr/sbin/nologin`, no password, no SSH keys, HOME = team dir) and the
0700 team dir. Nothing else is needed.

**Fail closed**: with `COBRA_LAUNCHER_SOCKET` set the runner only uses the launcher (down/refused = the step fails);
in production (`NODE_ENV=production`) without it, agent steps refuse to run.

Install / roll back (root, from this dir): `./install.sh` / `./rollback.sh`. Tests: `python3 -m unittest launcher/test_launcher.py`
(validation, socket flow with a faked unit) and `web/test/run-launcher.test.ts` (runner ↔ fake launcher).
