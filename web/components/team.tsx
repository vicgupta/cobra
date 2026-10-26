import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { MemberControls } from "@/components/collab";
import { designatedLead, isSystemAdmin } from "@/lib/collab";
import { displayTeamMembers } from "@/lib/team";
import { getDb } from "@/lib/workflows/server";
import { listInvites, listJoinRequests, signupSettings } from "@/lib/registration";
import { InviteForm, JoinRequestActions, RevokeInvite, SignupToggle } from "@/components/team-invites";

const ts = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }) + " ET";
const STATUS_TONE: Record<string, "green" | "gray" | "amber" | "blue"> = { active: "green", pending: "amber", link_sent: "blue", used: "gray", accepted: "green", revoked: "gray", dismissed: "gray", expired: "gray" };

const ROLE: Record<string, string> = { admin: "System admin", team_lead: "Team lead", member: "Member" };

/** Team settings (Job 25): designated lead, members and roles. Rules are enforced in lib/team.ts. */
export function TeamView() {
  return (
    <CollabPage title="Team settings">
      {(u) => {
        const db = getDb(), d = designatedLead(db, u.tenantId), members = displayTeamMembers(db, u.tenantId);
        const admin = isSystemAdmin(u), canAct = admin || u.role === "team_lead";
        return (
          <div className="space-y-6">
            <Card title="Members" subtitle={admin ? "System admins can promote and demote. Admin roles aren't changed here." : u.role === "team_lead" ? "Team leads can promote members and demote other team leads (not themselves or the designated lead)." : "View only."}>
              <table className="w-full text-sm" data-members>
                <thead><tr className="text-left text-xs text-subtle"><th className="py-2">Email</th><th>Role</th>{canAct && <th>Actions</th>}</tr></thead>
                <tbody className="divide-y divide-border">{members.map((m) => (
                  <tr key={m.id} data-member={m.email}>
                    <td className="py-2 font-mono">{m.email}</td>
                    <td data-role>{ROLE[m.role] ?? m.role}</td>
                    {canAct && <td><MemberControls member={m} viewer={{ id: u.id, role: u.role }} designatedId={d?.id ?? null} /></td>}
                  </tr>
                ))}</tbody>
              </table>
            </Card>
            {canAct && (() => {
              const now = Date.now(), reqs = listJoinRequests(db, u.tenantId, now), invites = listInvites(db, u.tenantId, now, 30);
              return <>
                <Card title="Invite people" subtitle={admin ? "Email a single-use magic link (7 days, only for that email). Admins can invite a team lead." : "Email a single-use magic link (7 days, only for that email). Invitees join as members."}>
                  <InviteForm canInviteLead={admin} />
                  {invites.length > 0 && (
                    <table className="mt-4 w-full text-sm" data-invites>
                      <thead><tr className="text-left text-xs text-subtle"><th className="py-2">Email</th><th>Role</th><th>Status</th><th>Sent</th><th></th></tr></thead>
                      <tbody className="divide-y divide-border">{invites.map((i) => (
                        <tr key={i.id} data-invite={i.email}>
                          <td className="py-2 font-mono">{i.email}</td><td>{ROLE[i.role] ?? i.role}</td>
                          <td><Badge tone={STATUS_TONE[i.status] ?? "gray"}>{i.status}</Badge></td>
                          <td className="text-xs text-muted">{ts(i.createdAt)} by {i.createdBy}{i.status === "active" && <> · expires {ts(i.expiresAt)}</>}</td>
                          <td>{i.status === "active" && <RevokeInvite id={i.id} />}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  )}
                </Card>
                {reqs.some((r) => r.status === "pending") && <Card title="Join requests" subtitle="People who asked to join this team and confirmed their email. Send them a magic link or dismiss. Unanswered requests expire after 14 days.">
                    <table className="w-full text-sm" data-join-requests>
                      <thead><tr className="text-left text-xs text-subtle"><th className="py-2">Requester</th><th>Status</th><th>Requested</th><th>Actions</th></tr></thead>
                      <tbody className="divide-y divide-border">{reqs.map((r) => (
                        <tr key={r.id} data-join-request={r.email}>
                          <td className="py-2"><span className="font-medium">{r.name}</span> <span className="font-mono text-xs text-muted">{r.email}</span></td>
                          <td><Badge tone={STATUS_TONE[r.status] ?? "gray"}>{r.status.replace("_", " ")}</Badge></td>
                          <td className="text-xs text-muted">{ts(r.createdAt)}{r.decidedBy && <> · {r.decidedBy}</>}</td>
                          <td>{(r.status === "pending" || r.status === "link_sent") && <JoinRequestActions id={r.id} resend={r.status === "link_sent"} />}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                </Card>}
                {admin && (() => { const s = signupSettings(db); return (
                  <Card title="Sign-ups" subtitle="System admins only. Applies to the whole Cobra install. Changes are audited.">
                    <SignupToggle allow={s.allowTeamSignups} />
                    {s.updatedBy && <p className="mt-2 text-xs text-subtle">Last changed {s.updatedAt ? ts(s.updatedAt) : ""} by {s.updatedBy}</p>}
                  </Card>
                ); })()}
              </>;
            })()}
          </div>
        );
      }}
    </CollabPage>
  );
}
