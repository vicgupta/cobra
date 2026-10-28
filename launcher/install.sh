#!/bin/bash
# Run as root from the repo's launcher/ dir. Idempotent. Creates cobra-run-<id> for every tenant in the DB, moves
# each team dir from /home/cobra/<id> to /srv/cobra-teams/<id> (0700, owned by the team user), installs the
# launcher (root-owned) + cobra-web drop-in. The shared npm CLI prefix /opt/cobra-tools is created owned by cobra
# (0755) so cobra's nightly updater can keep updating it while run users can only execute it.
set -euo pipefail
cd "$(dirname "$0")"
LIB=/usr/local/lib/cobra-launcher TEAMS=/srv/cobra-teams TOOLS=/opt/cobra-tools
install -d -o root -g root -m 0755 "$LIB" "$TEAMS"
install -o root -g root -m 0755 launcher.py stage.py "$LIB/"
install -o root -g root -m 0644 cobra-launcher.service /etc/systemd/system/cobra-launcher.service
# Shared CLI prefix (copy of cobra's live npm installs; .cobra-prev dirs not copied).
if [ ! -d "$TOOLS/lib/node_modules" ]; then
  install -d -o cobra -g cobra -m 0755 "$TOOLS"
  runuser -u cobra -- bash -c "umask 022; mkdir -p $TOOLS/bin $TOOLS/lib/node_modules/@anthropic-ai $TOOLS/lib/node_modules/@openai $TOOLS/share
    cp -a /home/cobra/.local/lib/node_modules/@anthropic-ai/claude-code $TOOLS/lib/node_modules/@anthropic-ai/
    cp -a /home/cobra/.local/lib/node_modules/@openai/codex $TOOLS/lib/node_modules/@openai/
    cp -a /home/cobra/.local/lib/node_modules/opencode-ai $TOOLS/lib/node_modules/
    cp -a /home/cobra/.local/bin/claude /home/cobra/.local/bin/codex /home/cobra/.local/bin/opencode $TOOLS/bin/
    chmod -R go-w,a+rX $TOOLS"
fi
# Per-team users + dirs.
for tid in $(python3 -c "import sqlite3;print(' '.join(str(r[0]) for r in sqlite3.connect('file:/var/lib/cobra/cobra.db?mode=ro',uri=True).execute('select id from tenants order by id')))"); do
  u="cobra-run-$tid"
  id "$u" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$TEAMS/$tid" --no-create-home --shell /usr/sbin/nologin "$u"
  if [ -d "/home/cobra/$tid" ] && [ ! -e "$TEAMS/$tid" ]; then mv "/home/cobra/$tid" "$TEAMS/$tid"; fi
  install -d -m 0700 "$TEAMS/$tid"
  chown -R "$u:$u" "$TEAMS/$tid"; chmod 0700 "$TEAMS/$tid"
done
install -d /etc/systemd/system/cobra-web.service.d
install -o root -g root -m 0644 cobra-web-run-users.conf /etc/systemd/system/cobra-web.service.d/zz-run-users.conf
systemctl daemon-reload
systemctl enable --now cobra-launcher.service
