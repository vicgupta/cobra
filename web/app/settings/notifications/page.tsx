import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { NotificationsForm } from "@/components/notifications-form";
import { isSystemAdmin } from "@/lib/collab";
import { getDb } from "@/lib/db";
import { fmtNy, listNotificationAudit, notificationStatus } from "@/lib/notifications";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Notifications · Settings · Cobra" };

/** Settings > Notifications: system admins only (404 for everyone else). */
export default function SettingsNotificationsPage() {
  return <CollabPage title="Notifications">{(u) => <Body u={u} />}</CollabPage>;
}

function Body({ u }: { u: Actor }) {
  if (!isSystemAdmin(u)) notFound();
  const db = getDb(), n = notificationStatus(db), log = listNotificationAudit(db, 20);
  return (
    <div className="space-y-6">
      <Card title="Daily analytics email" subtitle={`${n.schedule}. Sent to every system admin. ${n.updatedBy ? `Last changed ${fmtNy(n.updatedAt!)} by ${n.updatedBy}.` : ""}`}>
        <div className="space-y-3 text-sm">
          <p data-daily-status={n.dailyEnabled ? "on" : "off"}>Status: {n.dailyEnabled ? "On" : "Off"}</p>
          <p data-recipients>Recipients: {n.recipients.join(", ") || "none"}</p>
          <p data-last-send>Last send: {n.lastSend ? `${fmtNy(n.lastSend.at)} (${n.lastSend.kind}, ${n.lastSend.status}${n.lastSend.error ? `: ${n.lastSend.error}` : ""})` : "never"}</p>
          <p className="text-xs text-subtle">Contents (last 24 h, all teams): runs by status, team and engine; failures with links; tokens and engine-reported cost by provider/model; skills and workflows edited and awaiting approval; issues, PRs and merges; users, sign-ins and rate-limit counters; audit highlights; host uptime, disk free and DB size. &quot;Send test now&quot; emails only you ({u.email}).</p>
          <NotificationsForm enabled={n.dailyEnabled} email={u.email} />
        </div>
      </Card>
      <Card title="Recent sends">
        <ul className="space-y-1 text-xs" data-sends>{n.recent.length ? n.recent.map((s, i) => <li key={i}>{fmtNy(s.at)} · {s.kind} · {s.sendDate} · {s.status}{s.error ? ` (${s.error})` : ""} · {s.recipients}</li>) : <li className="text-subtle">None yet</li>}</ul>
      </Card>
      <Card title="Audit">
        <ul className="space-y-1 text-xs" data-notify-audit>{log.length ? log.map((a, i) => <li key={i}>{fmtNy(a.at)} · {a.actorEmail} · {a.detail}</li>) : <li className="text-subtle">No changes yet</li>}</ul>
      </Card>
    </div>
  );
}
