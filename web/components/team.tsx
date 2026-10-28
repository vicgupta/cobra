import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { MemberControls } from "@/components/collab";
import { designatedLead, isSystemAdmin } from "@/lib/collab";
import { displayTeamMembers } from "@/lib/team";
import { getDb } from "@/lib/workflows/server";
import { listInvites, listJoinRequests, signupSettings } from "@/lib/registration";
import { CreateTeamForm, InviteForm, JoinRequestActions, JoinTeamButton, RevokeInvite, SignupToggle } from "@/components/team-invites";
import { listTeams } from "@/lib/admin-teams";
import { tableCls, td, th, theadCls } from "@/components/styles";

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
              <div className="-mx-5 overflow-x-auto"><table className={tableCls} data-members>
                <thead className={theadCls}><tr><th scope="col" className={th}>Email</th><th scope="col" className={th}>Role</th>{canAct && <th scope="col" className={th}>Actions</th>}</tr></thead>
                <tbody className="divide-y divide-border">{members.map((m) => (
                  <tr className="transition-colors hover:bg-surface-2/40" key={m.id} data-member={m.email}>
                    <td className={`${td} font-mono`}>{m.email}</td>
                    <td data-role className={td}>{ROLE[m.role] ?? m.role}</td>
                    {canAct && <td className={td}><MemberControls member={m} viewer={{ id: u.id, role: u.role }} designatedId={d?.id ?? null} /></td>}
                  </tr>
                ))}</tbody>
              </table></div>
            </Card>
            {canAct && (() => {
              const now = Date.now(), reqs = listJoinRequests(db, u.tenantId, now), invites = listInvites(db, u.tenantId, now, 30);
              return <>
                <Card title="Invite people" subtitle={admin ? "Email a single-use magic link (7 days, only for that email). Admins can invite a team lead." : "Email a single-use magic link (7 days, only for that email). Invitees join as members."}>
                  <InviteForm canInviteLead={admin} />
                  {invites.length > 0 && (
                    <div className="mt-4 -mx-5 overflow-x-auto"><table className={tableCls} data-invites>
                      <thead className={theadCls}><tr><th scope="col" className={th}>Email</th><th scope="col" className={th}>Role</th><th scope="col" className={th}>Status</th><th scope="col" className={th}>Sent</th><th scope="col" className={th}><span className="sr-only">Actions</span></th></tr></thead>
                      <tbody className="divide-y divide-border">{invites.map((i) => (
                        <tr className="transition-colors hover:bg-surface-2/40" key={i.id} data-invite={i.email}>
                          <td className={`${td} font-mono`}>{i.email}</td><td className={td}>{ROLE[i.role] ?? i.role}</td>
                          <td className={td}><Badge tone={STATUS_TONE[i.status] ?? "gray"}>{i.status}</Badge></td>
                          <td className={`${td} text-xs text-muted`}>{ts(i.createdAt)} by {i.createdBy}{i.status === "active" && <> · expires {ts(i.expiresAt)}</>}</td>
                          <td className={td}>{i.status === "active" && <RevokeInvite id={i.id} />}</td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </Card>
                {reqs.some((r) => r.status === "pending") && <Card title="Join requests" subtitle="People who asked to join this team and confirmed their email. Send them a magic link or dismiss. Unanswered requests expire after 14 days.">
                    <div className="-mx-5 overflow-x-auto"><table className={tableCls} data-join-requests>
                      <thead className={theadCls}><tr><th scope="col" className={th}>Requester</th><th scope="col" className={th}>Status</th><th scope="col" className={th}>Requested</th><th scope="col" className={th}>Actions</th></tr></thead>
                      <tbody className="divide-y divide-border">{reqs.map((r) => (
                        <tr className="transition-colors hover:bg-surface-2/40" key={r.id} data-join-request={r.email}>
                          <td className={td}><span className="font-medium">{r.name}</span> <span className="font-mono text-xs text-muted">{r.email}</span></td>
                          <td className={td}><Badge tone={STATUS_TONE[r.status] ?? "gray"}>{r.status.replace("_", " ")}</Badge></td>
                          <td className={`${td} text-xs text-muted`}>{ts(r.createdAt)}{r.decidedBy && <> · {r.decidedBy}</>}</td>
                          <td className={td}>{(r.status === "pending" || r.status === "link_sent") && <JoinRequestActions id={r.id} resend={r.status === "link_sent"} />}</td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                </Card>}
                {admin && (() => { const s = signupSettings(db); return (
                  <Card title="Sign-ups" subtitle="System admins only. Applies to the whole Cobra install. Changes are audited.">
                    <SignupToggle allow={s.allowTeamSignups} />
                    {s.updatedBy && <p className="mt-2 text-xs text-subtle">Last changed {s.updatedAt ? ts(s.updatedAt) : ""} by {s.updatedBy}</p>}
                  </Card>
                ); })()}
                {admin && (() => { const teams = listTeams(db, u); return (
                  <Card title="Teams" subtitle="System admins only. Create a team, or join one to work in it. You're in one team at a time; team-scoped things (skills, agents, repos) follow the team you're in.">
                    <CreateTeamForm />
                    <div className="mt-4 -mx-5 overflow-x-auto"><table className={tableCls} data-teams>
                      <thead className={theadCls}><tr><th scope="col" className={th}>Team</th><th scope="col" className={th}>Slug</th><th scope="col" className={th}>Members</th><th scope="col" className={th}><span className="sr-only">Actions</span></th></tr></thead>
                      <tbody className="divide-y divide-border">{teams.map((t) => (
                        <tr className="transition-colors hover:bg-surface-2/40" key={t.id} data-team={t.slug}>
                          <td className={td}>{t.name}</td><td className={`${td} font-mono text-xs`}>{t.slug}</td><td className={td}>{t.members}</td>
                          <td className={td}>{t.current ? <Badge tone="green">current</Badge> : <JoinTeamButton id={t.id} name={t.name} />}</td>
                        </tr>
                      ))}</tbody>
                    </table></div>
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
