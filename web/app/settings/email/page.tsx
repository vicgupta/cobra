import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { TeamEmailForm } from "@/components/team-email-form";
import { getDb } from "@/lib/db";
import { fmtNy } from "@/lib/notifications";
import { teamEmailAudit, teamEmailStatus } from "@/lib/team-email";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Email · Settings · Cobra" };

/** Settings > Email: the team's one kantsy.com mailbox. Team leads, the designated lead and system admins manage it. */
export default function SettingsEmailPage() {
  return <CollabPage title="Email">{(u) => <Body u={u} />}</CollabPage>;
}

function Body({ u }: { u: Actor }) {
  const db = getDb(), s = teamEmailStatus(db, u), log = s.canEdit ? teamEmailAudit(db, u.tenantId) : [];
  const e = s.email;
  return (
    <div className="space-y-6">
      <Card title="Team email" subtitle="One kantsy.com address for the whole team. Agents with “Can use team email” turned on can send and read mail with it. The access token is stored encrypted and is never shown.">
        <div className="space-y-3 text-sm" data-team-email>
          <p data-team-email-status={e ? "set" : "none"}>{e ? <>Address: <strong>{e.address}</strong>{e.displayName ? ` (${e.displayName})` : ""} · Tier: {e.tier ?? "unknown"} · Token: stored (encrypted) · Set {fmtNy(e.setAt)}{e.setBy ? ` by ${e.setBy}` : ""}</> : "Not set up yet."}</p>
          {s.canEdit
            ? <TeamEmailForm current={e?.address ?? null} />
            : <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-xs text-subtle">Only team leads, the designated lead and system admins can change this.</p>}
        </div>
      </Card>
      {s.canEdit && (
        <Card title="Changes">
          <ul className="divide-y divide-border text-xs [&>li]:py-2" data-team-email-audit>{log.length ? log.map((r, i) => <li key={i}>{fmtNy(r.at)} · {r.actor} · {r.action} · {r.detail}</li>) : <li className="text-subtle">None yet</li>}</ul>
        </Card>
      )}
    </div>
  );
}
