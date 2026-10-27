import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { DigestView } from "@/components/digest-view";
import { NotifyToggleForm } from "@/components/notify-toggle-form";
import { isSystemAdmin } from "@/lib/collab";
import { dbPath, getDb } from "@/lib/db";
import { adminDigestNow, fmtNy, notificationStatus, serviceHealth } from "@/lib/notifications";
import { teamDigestFor, teamNotifyStatus } from "@/lib/team-notifications";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Notifications · Settings · Cobra" };

const TONE = { sent: "green", failed: "red", skipped: "gray", sending: "blue" } as const;
type Row = { kind: string; sendDate: string; status: string; error: string | null; at: number; recipients: string };

function Sends({ rows, attr }: { rows: Row[]; attr: string }) {
  return (
    <ul className="space-y-1 text-xs" data-sends={attr}>{rows.length ? rows.map((s, i) => (
      <li key={i}>{fmtNy(s.at)} · {s.kind} · {s.sendDate} · <Badge tone={TONE[s.status as keyof typeof TONE] ?? "gray"}>{s.status}</Badge>{s.error ? ` (${s.error})` : ""} · {s.recipients}</li>
    )) : <li className="text-subtle">None yet</li>}</ul>
  );
}
const last = (s: Row | null) => (s ? `${fmtNy(s.at)} (${s.kind}, ${s.status}${s.error ? `: ${s.error}` : ""})` : "never");

/** Settings > Notifications. Team section: every member, own team only (tenant from the session).
 *  All-teams section: system admins only (never rendered for anyone else). */
export default function SettingsNotificationsPage() {
  return <CollabPage title="Notifications">{(u) => <Body u={u} />}</CollabPage>;
}

function Body({ u }: { u: Actor }) {
  const db = getDb(), t = teamNotifyStatus(db, u), d = teamDigestFor(db, u);
  const admin = isSystemAdmin(u);
  return (
    <div className="space-y-6">
      <Card title={`Team digest: ${d.teamName}`} subtitle={`${t.schedule}. Your team's last 24 hours only. Emailed from cobra@kantsy.com to ${t.recipients.join(", ") || "nobody (no designated lead or team lead)"}.`}>
        <div className="space-y-3 text-sm" data-team-notify>
          <p data-team-status={t.enabled ? "on" : "off"}>Status: {t.enabled ? "On" : "Off"} · Last sent: {last(t.lastSend)}</p>
          {t.canEdit
            ? <NotifyToggleForm scope="team" api="/api/team-notifications" enabled={t.enabled} label="Email the team digest daily" testLabel="Send test team digest" recipients={t.recipients.join(", ")} />
            : <p className="text-xs text-subtle">Only team leads, the designated lead and system admins can change this.</p>}
        </div>
      </Card>
      <Card title="Your team, last 24 hours"><DigestView d={d} /></Card>
      <Card title="Recent team sends"><Sends rows={t.recent} attr="team" /></Card>
      {admin && <AdminSection />}
    </div>
  );
}

function AdminSection() {
  const db = getDb(), n = notificationStatus(db), d = adminDigestNow(db, serviceHealth(dbPath(), "/var/lib/cobra"));
  return (
    <div className="space-y-6" data-admin-notify>
      <Card title="All-teams digest (system admin)" subtitle={`Daily at 7:00 AM ET. Emailed from cobra@kantsy.com. ${n.updatedBy ? `Last changed ${fmtNy(n.updatedAt!)} by ${n.updatedBy}.` : ""}`}>
        <div className="space-y-3 text-sm">
          <p data-daily-status={n.dailyEnabled ? "on" : "off"}>Status: {n.dailyEnabled ? "On" : "Off"}</p>
          <p data-recipients>Recipient: {n.recipients.join(", ") || "none (set COBRA_ADMIN_EMAIL)"}</p>
          <p data-last-send>Last sent: {last(n.lastSend)}</p>
          <NotifyToggleForm scope="admin" api="/api/notifications" enabled={n.dailyEnabled} label="Email the all-teams digest daily" testLabel="Send test digest now" recipients={n.recipients.join(", ")} />
        </div>
      </Card>
      <Card title="All teams, last 24 hours"><DigestView d={d} /></Card>
      <Card title="Recent admin digest sends (last 10)"><Sends rows={n.recent} attr="admin" /></Card>
    </div>
  );
}
