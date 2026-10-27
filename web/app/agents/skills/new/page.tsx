import Link from "next/link";
import { CollabPage } from "@/components/collab-page";
import { Card } from "@/components/ui";
import { SkillEditor, type Starter } from "@/components/skills";
import { MASTER_STARTER_BODY } from "@/lib/skills/store";
import { SKILL_TEMPLATES } from "@/lib/skills/templates";

export const metadata = { title: "New skill · Cobra" };

export default function NewSkillPage() {
  return <CollabPage title="New skill" crumbs={<Link href="/agents/skills" className="hover:underline">Agents · Skills</Link>}>{() => {
    const starters: Starter[] = [
      ...SKILL_TEMPLATES,
      { key: "master", label: "Master skill (workflow)", name: "my-workflow", description: "Compose skills with call_skill steps", body: MASTER_STARTER_BODY, kind: "master" as const },
    ];
    return <Card title="Create a skill" subtitle="Visible to your team only."><SkillEditor starters={starters} /></Card>;
  }}</CollabPage>;
}
