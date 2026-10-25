import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { DesignatedLeadForm } from "@/components/collab";
import { designatedLead, isSystemAdmin, teamLeads } from "@/lib/collab";
import { getDb } from "@/lib/workflows/server";

export const metadata = { title: "Team · Cobra" };

export default function TeamPage() {
  return (
    <CollabPage title="Team settings">
      {(u) => {
        const db = getDb(), leads = teamLeads(db, u.tenantId), d = designatedLead(db, u.tenantId);
        return (
          <Card title="Designated lead" subtitle="One of the team's team leads. Only the designated lead and system admins can merge pull requests. Only a system admin can change this.">
            {isSystemAdmin(u)
              ? leads.length ? <DesignatedLeadForm leads={leads} current={d?.id ?? null} /> : <p className="text-sm text-zinc-500">This team has no team leads yet.</p>
              : <p className="text-sm">{d ? d.email : "No designated lead set."}</p>}
            <p className="mt-3 text-xs text-zinc-500">Team leads: {leads.map((l) => l.email).join(", ") || "none"}</p>
          </Card>
        );
      }}
    </CollabPage>
  );
}
