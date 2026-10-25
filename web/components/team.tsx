import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { DesignatedLeadForm, MemberControls } from "@/components/collab";
import { designatedLead, isSystemAdmin, teamLeads } from "@/lib/collab";
import { listTeamAudit, teamMembers } from "@/lib/team";
import { getDb } from "@/lib/workflows/server";

const ROLE: Record<string, string> = { admin: "System admin", team_lead: "Team lead", member: "Member" };

/** Team settings (Job 25): designated lead, members and roles. Rules are enforced in lib/team.ts. */
export function TeamView() {
  return (
    <CollabPage title="Team settings">
      {(u) => {
        const db = getDb(), leads = teamLeads(db, u.tenantId), d = designatedLead(db, u.tenantId), members = teamMembers(db, u.tenantId);
        const admin = isSystemAdmin(u), canAct = admin || u.role === "team_lead";
        const log = canAct ? listTeamAudit(db, u.tenantId, 20) : [];
        return (
          <div className="space-y-6">
            <Card title="Designated lead" subtitle="One of the team's team leads. Only the designated lead and system admins can merge pull requests. Only a system admin can set, change or clear it.">
              <p className="text-lg font-medium" data-designated-lead>{d ? d.email : "None set"}</p>
              {admin && <div className="mt-3">{leads.length ? <DesignatedLeadForm leads={leads} current={d?.id ?? null} /> : <p className="text-sm text-zinc-500">No team leads yet: use “Make designated lead” on a member below.</p>}</div>}
            </Card>
            <Card title="Members" subtitle={admin ? "System admins can promote, demote and designate. Admin roles aren't changed here." : u.role === "team_lead" ? "Team leads can promote members and demote other team leads (not themselves or the designated lead)." : "View only."}>
              <table className="w-full text-sm" data-members>
                <thead><tr className="text-left text-xs text-zinc-500"><th className="py-2">Email</th><th>Role</th>{canAct && <th>Actions</th>}</tr></thead>
                <tbody className="divide-y divide-zinc-800">{members.map((m) => (
                  <tr key={m.id} data-member={m.email}>
                    <td className="py-2 font-mono">{m.email}{d?.id === m.id && <span className="ml-2"><Badge tone="blue">designated lead</Badge></span>}</td>
                    <td data-role>{ROLE[m.role] ?? m.role}</td>
                    {canAct && <td><MemberControls member={m} viewer={{ id: u.id, role: u.role }} designatedId={d?.id ?? null} /></td>}
                  </tr>
                ))}</tbody>
              </table>
            </Card>
            {canAct && log.length > 0 && (
              <Card title="Recent team changes">
                <ul className="space-y-1 text-xs text-zinc-400">{log.map((l, i) => <li key={i}>{new Date(l.at).toISOString().slice(0, 16).replace("T", " ")} UTC · {l.actorEmail} · {l.action} {l.targetEmail ?? ""} {l.detail && `(${l.detail})`}</li>)}</ul>
              </Card>
            )}
          </div>
        );
      }}
    </CollabPage>
  );
}
