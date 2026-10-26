import { Card } from "@/components/ui";
import { CollabPage, RepoPicker } from "@/components/collab-page";

export const metadata = { title: "Pull requests · Cobra" };

export default function PullsIndex() {
  return <CollabPage title="Pull requests">{(u) => <Card title="Team repos" subtitle="Pick a repo to see its pull requests."><RepoPicker u={u} kind="pulls" /></Card>}</CollabPage>;
}
