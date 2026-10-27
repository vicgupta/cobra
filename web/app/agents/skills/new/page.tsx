import Link from "next/link";
import { CollabPage } from "@/components/collab-page";
import { Card } from "@/components/ui";
import { SkillEditor, type Starter } from "@/components/skills";
import { getDb } from "@/lib/workflows/server";
import { listSkills, MASTER } from "@/lib/skills/store";

export const metadata = { title: "New skill · Cobra" };

export default function NewSkillPage() {
  return <CollabPage title="New skill" crumbs={<Link href="/agents/skills" className="hover:underline">Agents · Skills library</Link>}>{(u) => {
    const master = listSkills(getDb(), u).find((s) => s.name === MASTER && s.tenantId === u.tenantId);
    const starters: Starter[] = [
      { key: "one-line", label: "One-line SOP", description: "A single instruction", body: "Fix the failing test and explain the root cause." },
      { key: "reviewed", label: "Implement + review", description: "Two agent steps, each given its own SOP section", body: "# Reviewed change\n\n## Implement\nMake the change with tests.\n\n## Review\nCheck correctness, tests and style.\n" },
      ...(master ? [{ key: "master", label: "Master skill (workflow)", description: "Compose skills with call_skill steps", body: master.body, kind: "master" as const }] : []),
    ];
    return <Card title="Create a skill" subtitle="Visible to your team only."><SkillEditor starters={starters} /></Card>;
  }}</CollabPage>;
}
