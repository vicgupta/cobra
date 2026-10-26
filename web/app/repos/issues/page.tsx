import { Card } from "@/components/ui";
import { CollabPage, RepoPicker } from "@/components/collab-page";

export const metadata = { title: "Issues · Cobra" };

export default function IssuesIndex() {
  return <CollabPage title="Issues">{(u) => <Card title="Team repos" subtitle="Pick a repo to see and create its GitHub issues."><RepoPicker u={u} kind="issues" /></Card>}</CollabPage>;
}
