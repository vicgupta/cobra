#!/bin/bash
# Run as root: undoes install.sh (launcher off, drop-in removed, team dirs back to /home/cobra/<id> owned by cobra,
# cobra-run-* users removed). Leaves /opt/cobra-tools (unused once the drop-in is gone) for inspection.
set -uo pipefail
TEAMS=/srv/cobra-teams
systemctl disable --now cobra-launcher.service 2>/dev/null
rm -f /etc/systemd/system/cobra-launcher.service /etc/systemd/system/cobra-web.service.d/zz-run-users.conf /run/cobra-launcher.sock
systemctl daemon-reload
for d in "$TEAMS"/*/; do
  [ -d "$d" ] || continue; tid=$(basename "$d")
  [[ "$tid" =~ ^[0-9]+$ ]] || continue
  if [ ! -e "/home/cobra/$tid" ]; then mv "$TEAMS/$tid" "/home/cobra/$tid"; chown -R cobra:cobra "/home/cobra/$tid"; fi
done
for u in $(getent passwd | cut -d: -f1 | grep -E '^cobra-run-[0-9]+$'); do userdel "$u"; done
rmdir "$TEAMS" 2>/dev/null || true
