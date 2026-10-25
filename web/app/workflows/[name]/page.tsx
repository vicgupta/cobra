import Link from "next/link";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Badge, Card } from "@/components/ui";
import { ApprovalPanel, CopyButton, RunForm, StatusBadge, SyncButton, type InputDef } from "@/components/workflows";
import { actor, getDb } from "@/lib/workflows/server";
import { workflowDetail } from "@/lib/workflows/service";
import type { SessionUser } from "@/lib/auth/sessions";

export const metadata = { title: "Workflow · Cobra" };

type D = {
  name: string; version: number; description?: string; origin: string; template: boolean; system: boolean; hash: string; owner: string; author: string | null;
  approvers: string[]; reviewers: string[]; minApprovals: number; approval: { status: string; reason?: string }; triggers: string[]; source: string;
  inputs: Record<string, InputDef>; steps: Array<{ id: string; name: string; uses: string; needs: string[]; if: string | null; secrets: string[] }>;
  decisions: Array<{ email: string; decision: string; comment: string | null; createdAt: number }>; selfApprovalPolicy: string;
  can: { approve: boolean; edit: boolean; run: boolean };
  storage: { kind: string; repo?: string; path?: string; branch?: string; sha?: string | null; syncedAt?: number | null } | null;
  instances: Array<{ name: string; templateHash: string | null; storage: string; createdAt: number; fromCurrentVersion: boolean }>;
  engine: string; prompt: string | null; repo: string | null; teamRepos: string[]; hasAgentStep: boolean;
  createdFrom: { name: string | null; hash: string | null } | null; runs: Array<{ id: string; status: string | null; startedAt: number; workflowHash: string }>;
};

function Detail({ user, name }: { user: SessionUser; name: string }) {
  const r = workflowDetail(getDb(), actor(user), name);
  if (r.status !== 200) return <p className="text-sm text-zinc-400">Workflow not found.</p>;
  const d = r.body as D;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{d.name}</h1>
        <Badge tone="gray">v{d.version}</Badge>
        <Badge tone={d.origin === "tenant" ? "blue" : "violet"}>{d.origin === "repo" ? "built-in" : d.origin === "template" ? "system template" : d.template ? "workspace template" : "workspace"}</Badge>
        {!d.template && <StatusBadge status={d.approval.status} />}
        <div className="ml-auto flex gap-2">
          <CopyButton text={d.source} />
          {d.template && <Link href={`/workflows/new?template=${encodeURIComponent(d.name)}`} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white">Use template</Link>}
          {d.storage?.kind === "github" && d.can.edit && <SyncButton name={d.name} />}
          {d.can.edit && <Link href={`/workflows/${encodeURIComponent(d.name)}/edit`} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800">Edit YAML</Link>}
        </div>
      </div>
      {d.description && <p className="text-sm text-zinc-400">{d.description}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Governance" subtitle="Set in the YAML under governance">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-zinc-500">Owner</dt><dd>{d.owner}</dd>
            {d.author && d.author !== d.owner && <><dt className="text-zinc-500">Last edited by</dt><dd>{d.author}</dd></>}
            <dt className="text-zinc-500">Approvers</dt><dd>{d.approvers.join(", ")}</dd>
            <dt className="text-zinc-500">Reviewers</dt><dd>{d.reviewers.join(", ") || "—"}</dd>
            <dt className="text-zinc-500">Needs</dt><dd>{d.minApprovals} approval(s); self-approval policy: {d.selfApprovalPolicy}</dd>
            {d.hasAgentStep && <><dt className="text-zinc-500">Engine</dt><dd>{d.engine === "codex" ? "Codex" : "Claude Code"} (default; overridable per run)</dd></>}
            {d.hasAgentStep && d.repo && <><dt className="text-zinc-500">Repo</dt><dd className="font-mono text-xs">{d.repo}</dd></>}
            <dt className="text-zinc-500">Triggers</dt><dd>{d.triggers.join(", ") || "—"}</dd>
            <dt className="text-zinc-500">Storage</dt><dd>{d.storage?.kind === "github" ? <span className="font-mono text-xs">github: {d.storage.repo}/{d.storage.path}{d.storage.branch ? `@${d.storage.branch}` : ""}</span> : d.storage?.kind === "database" ? "Cobra database" : d.storage?.kind}</dd>
            {d.createdFrom?.name && <><dt className="text-zinc-500">From template</dt><dd><Link className="text-emerald-300 hover:underline" href={`/workflows/${encodeURIComponent(d.createdFrom.name)}`}>{d.createdFrom.name}</Link> <span className="font-mono text-xs text-zinc-500">@{d.createdFrom.hash?.slice(0, 12)}</span></dd></>}
            <dt className="text-zinc-500">Version hash</dt><dd className="font-mono text-xs">{d.hash.slice(0, 16)}</dd>
          </dl>
        </Card>

        <Card title="Approval" subtitle={d.approval.reason}>
          {d.decisions.length > 0 ? (
            <ul className="mb-4 space-y-2 text-sm">
              {d.decisions.map((x, i) => (
                <li key={i}><StatusBadge status={x.decision === "approve" ? "approved" : "rejected"} /> <span className="ml-2">{x.email}</span>
                  <span className="ml-2 text-xs text-zinc-500">{new Date(x.createdAt).toLocaleString()}</span>
                  {x.comment && <p className="mt-1 text-xs text-zinc-400">“{x.comment}”</p>}</li>
              ))}
            </ul>
          ) : <p className="mb-4 text-sm text-zinc-500">{d.template ? "Templates are not run directly; copies need approval." : "No decisions on this version yet."}</p>}
          {d.can.approve ? <ApprovalPanel name={d.name} hash={d.hash} /> : !d.template && <p className="text-xs text-zinc-500">You are not an approver for this workflow.</p>}
        </Card>
      </div>

      <Card title="Steps" subtitle="Read-only; edit the YAML to change them">
        <ol className="space-y-2 text-sm">
          {d.steps.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-zinc-500">{i + 1}.</span><span className="font-mono text-xs">{s.id}</span><Badge tone="gray">{s.uses}</Badge>
              <span>{s.name}</span>
              {s.needs.length > 0 && <span className="text-xs text-zinc-500">after {s.needs.join(", ")}</span>}
              {s.if && <span className="font-mono text-xs text-zinc-500">if {s.if}</span>}
              {s.secrets.length > 0 && <span className="text-xs text-amber-300">secrets: {s.secrets.join(", ")}</span>}
            </li>
          ))}
        </ol>
      </Card>

      {!d.template && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card title="Run">
            <RunForm name={d.name} inputs={d.inputs} enabled={d.can.run} hasAgentStep={d.hasAgentStep} flow={{ engine: d.engine, prompt: d.prompt, repo: d.repo, repos: d.teamRepos }}
              reason={d.approval.status !== "approved" ? "Runs are enabled once this exact version is approved." : "Templates can't be run; create a workflow from it first."} />
          </Card>
          <Card title="Recent runs">
            {d.runs.length === 0 ? <p className="text-sm text-zinc-500">No runs yet.</p> : (
              <ul className="space-y-1 text-sm">
                {d.runs.map((x) => (
                  <li key={x.id} className="flex items-center gap-3"><Link className="font-mono text-xs text-emerald-300 hover:underline" href={`/runs/${x.id}`}>{x.id}</Link>
                    <StatusBadge status={x.status} /><span className="text-xs text-zinc-500">{new Date(x.startedAt).toLocaleString()}</span></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {d.template && (
        <Card title={`Instances (${d.instances.length})`} subtitle="Workflows created from this template; each has its own owner, approvals and runs">
          {d.instances.length === 0 ? <p className="text-sm text-zinc-500">None yet.</p> : (
            <ul className="space-y-1 text-sm">{d.instances.map((i) => (
              <li key={i.name} className="flex items-center gap-3"><Link className="text-emerald-300 hover:underline" href={`/workflows/${encodeURIComponent(i.name)}`}>{i.name}</Link>
                <span className="font-mono text-xs text-zinc-500">from @{i.templateHash?.slice(0, 12)}{i.fromCurrentVersion ? "" : " (older version)"}</span><span className="text-xs text-zinc-500">{i.storage}</span></li>))}</ul>
          )}
        </Card>
      )}

      <Card title="YAML"><pre className="max-h-[40rem] overflow-auto font-mono text-xs">{d.source}</pre></Card>
    </div>
  );
}

async function Body({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <AuthGate>{(u) => <Detail user={u} name={decodeURIComponent(name)} />}</AuthGate>;
}

export default function WorkflowPage({ params }: { params: Promise<{ name: string }> }) {
  return <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}><Body params={params} /></Suspense>;
}
