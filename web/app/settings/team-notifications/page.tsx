import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { TeamNotificationsForm } from "@/components/team-notifications-form";
import { getDb } from "@/lib/db";
import { fmtNy } from "@/lib/notifications";
import { listTeamNotifyAudit, teamNotifyStatus } from "@/lib/team-notifications";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Team notifications · Settings · Cobra" };

/** Settings > Team notifications: the signed-in user's own team. Everyone sees it; leads/admins edit. */
export default function TeamNotificationsPage() {
  return <CollabPage title="Team notifications">{(u) => <Body u={u} />}</CollabPage>;
}

function Body({ u }: { u: Actor }) {
  const db = getDb(), n = teamNotifyStatus(db, u), log = listTeamNotifyAudit(db, u.tenantId);
  return (
    <div className="space-y-6">
      <Card title="Team daily email" subtitle={`${n.schedule}. Covers only this team's last 24 hours. ${n.updatedBy ? `Last changed ${fmtNy(n.updatedAt!)} by ${n.updatedBy}.` : ""}`}>
        <div className="space-y-3 text-sm">
          <p data-team-daily-status={n.enabled ? "on" : "off"}>Status: {n.enabled ? "On" : "Off"} · Recipients: <strong>{n.modeLabel}</strong>{n.canEdit ? "" : " (team leads and admins can change this)"}</p>
          <div data-resolved-recipients>
            <p>Will be sent to ({n.recipients.length}): {n.recipients.join(", ") || "nobody (the daily send is skipped)"}</p>
            {n.candidates.some((c) => c.optedOut) && <p className="text-xs text-subtle">Opted out: {n.candidates.filter((c) => c.optedOut).map((c) => c.email).join(", ")}</p>}
          </div>
          <p data-last-send>Last send: {n.lastSend ? `${fmtNy(n.lastSend.at)} (${n.lastSend.kind}, ${n.lastSend.status}${n.lastSend.error ? `: ${n.lastSend.error}` : ""})` : "never"}</p>
          <p className="text-xs text-subtle">Contents (this team only): runs by status, engine and provider; failures with links; token usage and engine-reported spend; skills and workflows changed or awaiting approval; issues, PRs and merges; join requests and invites; new members; team audit highlights.{n.canEdit ? ` "Send test now" emails only you (${u.email}).` : ""}</p>
          <TeamNotificationsForm canEdit={n.canEdit} enabled={n.enabled} mode={n.mode} myOptOut={n.myOptOut} email={u.email} />
        </div>
      </Card>
      <Card title="Recent sends">
        <ul className="space-y-1 text-xs" data-team-recent-sends>{n.recent.length ? n.recent.map((r, i) => <li key={i}>{fmtNy(r.at)} · {r.kind} · {r.status}{r.error ? ` (${r.error})` : ""} · {r.recipients || "no recipients"}</li>) : <li className="text-subtle">None yet</li>}</ul>
      </Card>
      <Card title="Audit">
        <ul className="space-y-1 text-xs" data-team-notify-audit>{log.length ? log.map((a, i) => <li key={i}>{fmtNy(a.at)} · {a.actorEmail} · {a.detail}</li>) : <li className="text-subtle">No changes yet</li>}</ul>
      </Card>
    </div>
  );
}
