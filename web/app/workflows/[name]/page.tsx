import Link from "next/link";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { Badge, Card } from "@/components/ui";
import { ApprovalPanel, CopyButton, RunForm, StatusBadge, SyncButton, type InputDef } from "@/components/workflows";
import { actor, getDb } from "@/lib/workflows/server";
import { workflowDetail } from "@/lib/workflows/service";
import { RunHistory } from "@/components/run-history";
import { parseHistoryFilter, parsePage, workflowRunHistory, type HistoryPage } from "@/lib/workflows/run-history";
import { runDeps } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";
import { engineLabel } from "@/lib/engines";

export const metadata = { title: "Workflow · Cobra" };

type D = {
  name: string; version: number; description?: string; origin: string; template: boolean; system: boolean; hash: string; owner: string; author: string | null;
  approvers: string[]; reviewers: string[]; minApprovals: number; approval: { status: string; reason?: string }; triggers: string[]; source: string;
  inputs: Record<string, InputDef>; steps: Array<{ id: string; name: string; uses: string; needs: string[]; if: string | null; secrets: string[]; agent: string | null }>;
  decisions: Array<{ email: string; decision: string; comment: string | null; createdAt: number }>; selfApprovalPolicy: string;
  can: { approve: boolean; edit: boolean; run: boolean };
  storage: { kind: string; repo?: string; path?: string; branch?: string; sha?: string | null; syncedAt?: number | null } | null;
  instances: Array<{ name: string; templateHash: string | null; storage: string; createdAt: number; fromCurrentVersion: boolean }>;
  engine: string; prompt: string | null; repo: string | null; teamRepos: string[]; hasAgentStep: boolean;
  sourceHash: string; agents: Array<{ name: string; engine: string; hash: string }>; agentErrors: string[];
  createdFrom: { name: string | null; hash: string | null } | null; runs: Array<{ id: string; status: string | null; startedAt: number; workflowHash: string }>;
};

type SP = { runs?: string | string[]; page?: string | string[] };

function Detail({ user, name, sp }: { user: SessionUser; name: string; sp: SP }) {
  const r = workflowDetail(getDb(), actor(user), name);
  if (r.status !== 200) return <p className="text-sm text-muted">Workflow not found.</p>;
  const d = r.body as D;
  // Same server-side scoping as GET /api/workflows/<name>/runs (team; system admins across teams).
  const h = d.template ? null : workflowRunHistory(getDb(), actor(user), name, { filter: parseHistoryFilter(sp.runs), page: parsePage(sp.page), secrets: runDeps(user.tenantId).redact() });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{d.name}</h1>
        <Badge tone="gray">v{d.version}</Badge>
        <Badge tone={d.origin === "tenant" ? "blue" : "violet"}>{d.origin === "repo" ? "built-in" : d.origin === "template" ? "system template" : d.template ? "workspace template" : "workspace"}</Badge>
        {!d.template && <StatusBadge status={d.approval.status} />}
        <div className="ml-auto flex gap-2">
          <CopyButton text={d.source} />
          {d.template && <Link href={`/workflows/new?template=${encodeURIComponent(d.name)}`} className="rounded-md bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent">Use template</Link>}
          {d.storage?.kind === "github" && d.can.edit && <SyncButton name={d.name} />}
          {d.can.edit && <Link href={`/workflows/${encodeURIComponent(d.name)}/edit`} className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-2">Edit YAML</Link>}
        </div>
      </div>
      {d.description && <p className="text-sm text-muted">{d.description}</p>}
      {d.agentErrors.length > 0 && (
        <div role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-danger">
          <p className="font-medium">This workflow can&apos;t run until these agent references are fixed:</p>
          <ul className="mt-1 list-disc pl-5">{d.agentErrors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Governance" subtitle="Set in the YAML under governance">
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-subtle">Owner</dt><dd>{d.owner}</dd>
            {d.author && d.author !== d.owner && <><dt className="text-subtle">Last edited by</dt><dd>{d.author}</dd></>}
            <dt className="text-subtle">Approvers</dt><dd>{d.approvers.join(", ")}</dd>
            <dt className="text-subtle">Reviewers</dt><dd>{d.reviewers.join(", ") || "—"}</dd>
            <dt className="text-subtle">Needs</dt><dd>{d.minApprovals} approval(s); self-approval policy: {d.selfApprovalPolicy}</dd>
            {d.hasAgentStep && <><dt className="text-subtle">Engine</dt><dd>{engineLabel(d.engine)} (default; overridable per run)</dd></>}
            {d.hasAgentStep && d.repo && <><dt className="text-subtle">Repo</dt><dd className="font-mono text-xs">{d.repo}</dd></>}
            <dt className="text-subtle">Triggers</dt><dd>{d.triggers.join(", ") || "—"}</dd>
            <dt className="text-subtle">Storage</dt><dd>{d.storage?.kind === "github" ? <span className="font-mono text-xs">github: {d.storage.repo}/{d.storage.path}{d.storage.branch ? `@${d.storage.branch}` : ""}</span> : d.storage?.kind === "database" ? "Cobra database" : d.storage?.kind}</dd>
            {d.createdFrom?.name && <><dt className="text-subtle">From template</dt><dd><Link className="text-success hover:underline" href={`/workflows/${encodeURIComponent(d.createdFrom.name)}`}>{d.createdFrom.name}</Link> <span className="font-mono text-xs text-subtle">@{d.createdFrom.hash?.slice(0, 12)}</span></dd></>}
            <dt className="text-subtle">Version hash</dt><dd className="font-mono text-xs">{d.hash.slice(0, 16)}</dd>
          </dl>
        </Card>

        <Card title="Approval" subtitle={d.approval.reason}>
          {d.decisions.length > 0 ? (
            <ul className="mb-4 space-y-2 text-sm">
              {d.decisions.map((x, i) => (
                <li key={i}><StatusBadge status={x.decision === "approve" ? "approved" : "rejected"} /> <span className="ml-2">{x.email}</span>
                  <span className="ml-2 text-xs text-subtle">{new Date(x.createdAt).toLocaleString()}</span>
                  {x.comment && <p className="mt-1 text-xs text-muted">“{x.comment}”</p>}</li>
              ))}
            </ul>
          ) : <p className="mb-4 text-sm text-subtle">{d.template ? "Templates are not run directly; copies need approval." : "No decisions on this version yet."}</p>}
          {d.can.approve ? <ApprovalPanel name={d.name} hash={d.hash} /> : !d.template && <p className="text-xs text-subtle">You are not an approver for this workflow.</p>}
        </Card>
      </div>

      <Card title="Steps" subtitle="Read-only; edit the YAML to change them">
        <ol className="space-y-2 text-sm">
          {d.steps.map((s, i) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-subtle">{i + 1}.</span><span className="font-mono text-xs">{s.id}</span><Badge tone="gray">{s.uses}</Badge>
              <span>{s.name}</span>
              {s.agent && (() => { const a = d.agents.find((x) => x.name === s.agent); return <Badge tone={a ? "blue" : "red"}>agent {s.agent}{a ? ` @ ${a.hash.slice(0, 12)}` : " (unknown)"}</Badge>; })()}
              {s.needs.length > 0 && <span className="text-xs text-subtle">after {s.needs.join(", ")}</span>}
              {s.if && <span className="font-mono text-xs text-subtle">if {s.if}</span>}
              {s.secrets.length > 0 && <span className="text-xs text-warning">secrets: {s.secrets.join(", ")}</span>}
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

        </div>
      )}

      {h?.status === 200 && (
        <Card title="Run history" subtitle="Every execution of this workflow, newest first (read-only audit trail; times in your local time zone)">
          <RunHistory data={h.body as HistoryPage} base={`/workflows/${encodeURIComponent(d.name)}`} />
        </Card>
      )}

      {d.template && (
        <Card title={`Instances (${d.instances.length})`} subtitle="Workflows created from this template; each has its own owner, approvals and runs">
          {d.instances.length === 0 ? <p className="text-sm text-subtle">None yet.</p> : (
            <ul className="space-y-1 text-sm">{d.instances.map((i) => (
              <li key={i.name} className="flex items-center gap-3"><Link className="text-success hover:underline" href={`/workflows/${encodeURIComponent(i.name)}`}>{i.name}</Link>
                <span className="font-mono text-xs text-subtle">from @{i.templateHash?.slice(0, 12)}{i.fromCurrentVersion ? "" : " (older version)"}</span><span className="text-xs text-subtle">{i.storage}</span></li>))}</ul>
          )}
        </Card>
      )}

      <Card title="YAML"><pre className="max-h-[40rem] overflow-auto rounded-md bg-code p-3 font-mono text-xs text-code-fg">{d.source}</pre></Card>
    </div>
  );
}

async function Body({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<SP> }) {
  const { name } = await params;
  const sp = await searchParams;
  return <AuthGate>{(u) => <Detail user={u} name={decodeURIComponent(name)} sp={sp} />}</AuthGate>;
}

export default function WorkflowPage({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<SP> }) {
  return <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><Body params={params} searchParams={searchParams} /></Suspense>;
}
