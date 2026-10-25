import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Card } from "@/components/ui";
import { AttachTemplate, YamlEditor } from "@/components/workflows";
import { listTeamRepos } from "@/lib/repos";
import { actor, getDb } from "@/lib/workflows/server";
import { listWorkflowsFor, templateCopy } from "@/lib/workflows/service";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "New workflow · Cobra" };

const starter = (email: string, template: boolean) => `name: my-workflow
version: 1
description: Describe what this workflow does.
${template ? "template: true\n" : ""}on:
  manual: true
governance:
  owner: ${email}
  approvers:
    - role: admin
inputs:
  message:
    type: string
    default: hello
steps:
  - id: hello
    uses: simulate
    with:
      duration_ms: 500
      message: \${{ inputs.message }}
    outputs:
      message: \${{ result.message }}
outputs:
  message: \${{ steps.hello.outputs.message }}
`;

function Editor({ user, template, kind }: { user: SessionUser; template?: string; kind?: string }) {
  const repos = listTeamRepos(getDb(), user.tenantId).map((r) => r.repo);
  if (template) {
    const r = templateCopy(getDb(), actor(user), template);
    if (r.status !== 200) return <p role="alert" className="text-sm text-rose-300">{(r.body as { error: string }).error}</p>;
    const b = r.body as { source: string; templateName: string | null };
    return <YamlEditor initial={b.source} templateName={b.templateName ?? undefined} repos={repos} />;
  }
  return <YamlEditor initial={starter(user.email, kind === "template")} repos={repos} />;
}

function Attach({ user }: { user: SessionUser }) {
  const templates = (listWorkflowsFor(getDb(), actor(user)).body as Array<{ name: string; template?: boolean }>).filter((w) => w.template).map((w) => w.name);
  return <AttachTemplate templates={templates} repos={listTeamRepos(getDb(), user.tenantId).map((r) => r.repo)} />;
}

async function Body({ searchParams }: { searchParams: Promise<{ template?: string; kind?: string }> }) {
  const sp = await searchParams;
  return (
    <>
    {!sp.template && sp.kind !== "template" && (
      <Card title="From a template" subtitle="Pick a template and one of your team's repos to create a workflow instance">
        <AuthGate>{(u) => <Attach user={u} />}</AuthGate>
      </Card>
    )}
    <Card title={sp.template ? `New workflow from ${sp.template}` : sp.kind === "template" ? "New workspace template" : "New workflow"}
      subtitle="Paste or write YAML (see docs/workflows.md). Set owner and approvers under governance.">
      <AuthGate>{(u) => <Editor user={u} template={sp.template} kind={sp.kind} />}</AuthGate>
    </Card>
    </>
  );
}

export default function NewWorkflowPage({ searchParams }: { searchParams: Promise<{ template?: string; kind?: string }> }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">New workflow</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><Body searchParams={searchParams} /></Suspense>
    </div>
  );
}
