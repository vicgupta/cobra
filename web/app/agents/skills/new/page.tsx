import Link from "next/link";
import { CollabPage } from "@/components/collab-page";
import { Card } from "@/components/ui";
import { SkillEditor, type Starter } from "@/components/skills";
import { getDb } from "@/lib/workflows/server";
import { listSkills, MASTER } from "@/lib/skills/store";
import { SKILL_TEMPLATES } from "@/lib/skills/templates";

export const metadata = { title: "New skill · Cobra" };

export default function NewSkillPage() {
  return <CollabPage title="New skill" crumbs={<Link href="/agents/skills" className="hover:underline">Agents · Skills library</Link>}>{(u) => {
    const master = listSkills(getDb(), u).find((s) => s.name === MASTER && s.tenantId === u.tenantId);
    const starters: Starter[] = [
      ...SKILL_TEMPLATES,
      ...(master ? [{ key: "master", label: "Master skill (workflow)", name: "my-workflow", description: "Compose skills with call_skill steps", body: master.body, kind: "master" as const }] : []),
    ];
    return <Card title="Create a skill" subtitle="Visible to your team only."><SkillEditor starters={starters} /></Card>;
  }}</CollabPage>;
}
