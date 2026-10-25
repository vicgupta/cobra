import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { YamlEditor } from "@/components/workflows";
import { actor, getDb } from "@/lib/workflows/server";
import { canEdit, findWorkflow, storageOf } from "@/lib/workflows/store";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Edit workflow · Cobra" };

function Editor({ user, name }: { user: SessionUser; name: string }) {
  const w = findWorkflow(getDb(), user.tenantId, name);
  if (!w) return <p className="text-sm text-zinc-400">Workflow not found.</p>;
  if (!canEdit(actor(user), w)) return <p className="text-sm text-zinc-400">{w.origin === "tenant" ? "Only the owner, approvers, team leads and admins can edit this workflow." : "Built-in workflows and system templates are read-only here (they change through the repo). Use a template to make your own copy."}</p>;
  return <YamlEditor initial={w.source} previousName={name} storage={storageOf(getDb(), user.tenantId, name) ?? undefined} />;
}

async function Body({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const n = decodeURIComponent(name);
  return <Card title={`Edit ${n}`}><AuthGate>{(u) => <Editor user={u} name={n} />}</AuthGate></Card>;
}

export default function EditWorkflowPage({ params }: { params: Promise<{ name: string }> }) {
  return <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><Body params={params} /></Suspense>;
}
