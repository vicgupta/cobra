import Link from "next/link";
import { notFound } from "next/navigation";
import { CollabPage } from "@/components/collab-page";
import { Card } from "@/components/ui";
import { SkillEditor } from "@/components/skills";
import { getDb } from "@/lib/workflows/server";
import { canEdit, getSkill, type Actor } from "@/lib/skills/store";

export const metadata = { title: "Edit skill · Cobra" };

export default function EditSkillPage({ params }: PageProps<"/agents/skills/[id]/edit">) {
  return <CollabPage title="Edit skill" crumbs={<Link href="/agents/skills" className="hover:underline">Agents · Skills</Link>}>{(u) => <Body u={u} params={params} />}</CollabPage>;
}
async function Body({ u, params }: { u: Actor; params: PageProps<"/agents/skills/[id]/edit">["params"] }) {
  const db = getDb();
  const s = getSkill(db, u, Number((await params).id));
  if (!s) notFound();
  if (!canEdit(db, u, s)) return <p className="text-sm text-muted">Only the creator, team leads, the designated lead and system admins can edit this skill.</p>;
  return <Card title={s.name} subtitle={"Changes are live for your whole team as soon as you save."}><SkillEditor id={s.id} initial={{ name: s.name, description: s.description, body: s.body }} /></Card>;
}
