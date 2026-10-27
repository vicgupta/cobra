import Link from "next/link";
import { notFound } from "next/navigation";
import { CollabPage } from "@/components/collab-page";
import { Badge, Card } from "@/components/ui";
import { StatusBadge } from "@/components/workflows";
import { Approve, RunSkill } from "@/components/skills";
import { getDb } from "@/lib/workflows/server";
import { detail } from "@/lib/skills/service";
import { sections } from "@/lib/skills/sections";
import type { Actor, ApprovalState, Skill } from "@/lib/skills/store";

export const metadata = { title: "Skill · Cobra" };

type D = {
  skill: Skill; summary: { team: string; status: string }; effective: { hash: string; parts: string[]; errors: string[] }; composed: Array<{ id: number; name: string; version: number }>; composeError: string | null;
  approval: ApprovalState; versions: Array<{ version: number; hash: string; savedAt: number; note: string | null; savedBy: string | null }>;
  runs: Array<{ id: string; status: string | null; mode: string | null; startedAt: number; triggeredBy: string | null }>; audit: Array<{ actor: string; action: string; detail: string; at: number }>;
  can: { edit: boolean; approve: boolean; run: boolean };
};
const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-surface-2 px-1 text-[0.85em]">{children}</code>;
const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";

export default function SkillPage({ params }: PageProps<"/agents/skills/[id]">) {
  return <CollabPage title="Skill" crumbs={<Link href="/agents/skills" className="hover:underline">Agents · Skills library</Link>}>{(u) => <Body u={u} params={params} />}</CollabPage>;
}

function PlanView({ s }: { s: Skill }) {
  const p = s.plan;
  return (
    <Card title={`Plan · ${p.steps.length} ordered step(s)`} subtitle="Executed top to bottom; when skips a step; on_failure stop | continue | goto (forward only)">
      <div className="grid gap-4 sm:grid-cols-2 text-sm">
        <div><h4 className="font-medium">Inputs</h4>{Object.keys(p.inputs).length ? <ul className="mt-1 space-y-1">{Object.entries(p.inputs).map(([k, d]) => <li key={k}><C>{k}</C> {d.type}{d.required && " · required"}{d.default !== undefined && ` · default ${JSON.stringify(d.default)}`} <span className="text-muted">{d.description}</span></li>)}</ul> : <p className="text-muted">None</p>}</div>
        <div><h4 className="font-medium">Outputs</h4>{Object.keys(p.outputs).length ? <ul className="mt-1 space-y-1">{Object.entries(p.outputs).map(([k, v]) => <li key={k}><C>{k}</C> ← <C>{v}</C></li>)}</ul> : <p className="text-muted">None</p>}</div>
      </div>
      {p.steps.length > 12 && <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted">Jump to a step</summary><div className="mt-1 flex flex-wrap gap-1">{p.steps.map((st) => <a key={st.id} href={`#step-${st.id}`} className="rounded bg-surface-2 px-1.5 text-xs text-fg-soft hover:text-fg">{st.id}</a>)}</div></details>}
      <ol className="mt-4 space-y-2" data-testid="plan-steps">{p.steps.map((st, i) => (
        <li key={st.id} id={`step-${st.id}`} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><span className="tabular-nums text-subtle">{i + 1}.</span><b className="font-medium">{st.name ?? st.id}</b><C>{st.id}</C><Badge tone={st.action === "call_skill" ? "violet" : st.action === "agent" ? "blue" : st.action === "github" ? "orange" : st.action === "approval" ? "amber" : "gray"}>{st.action}{st.skill ? `: ${st.skill}` : ""}{st.action === "github" ? `: ${String(st.with.action ?? "")}` : ""}</Badge>
            <span className="text-xs text-muted">on_failure: {st.on_failure === undefined ? "stop (implicit)" : typeof st.on_failure === "object" ? <a className="hover:underline" href={`#step-${st.on_failure.goto}`}>goto {st.on_failure.goto}</a> : st.on_failure}</span>
            {st.retries > 0 && <span className="text-xs text-muted">retries {st.retries}</span>}</div>
          {st.when && <p className="mt-1 text-xs"><span className="text-warning">when</span> <C>{st.when}</C></p>}
          {st.section && <p className="mt-1 text-xs">SOP section: <a className="text-success hover:underline" href={`#sec-${st.section}`}>#{st.section}</a></p>}
          {st.handoffs.length > 0 && <p className="mt-1 text-xs">handoffs: {st.handoffs.map((h) => <span key={h.to} className="mr-2"><C>{h.from}</C> → <C>{`{{${h.to}}}`}</C></span>)}</p>}
          {Object.keys(st.with).length > 0 && <details className="mt-1 text-xs"><summary className="cursor-pointer text-muted">with</summary><pre className="mt-1 whitespace-pre-wrap break-words rounded bg-surface-2 p-2">{JSON.stringify(st.with, null, 2)}</pre></details>}
          {Object.keys(st.outputs).length > 0 && <p className="mt-1 text-xs text-muted">outputs: {Object.entries(st.outputs).map(([k, v]) => `${k} ← ${v}`).join(", ")}</p>}
          {st.secrets.length > 0 && <p className="mt-1 text-xs text-muted">secrets (names only): {st.secrets.join(", ")}</p>}
        </li>))}</ol>
    </Card>
  );
}

function SopView({ body }: { body: string }) {
  if (!body.trim()) return <Card title="SOP"><p className="text-sm text-muted">No SOP text; the plan alone defines this skill.</p></Card>;
  const secs = sections(body);
  const first = secs.length ? secs[0].start : body.length;
  const intro = body.slice(0, first).trim();
  return (
    <Card title={`SOP · ${body.split("\n").length} lines · ${secs.length} section(s)`} subtitle="Agent steps get their section in the prompt and the full SOP as .cobra/SOP.md">
      {intro && <pre className="mb-2 whitespace-pre-wrap break-words text-sm text-fg-soft">{intro}</pre>}
      <div className="space-y-1">{secs.map((s, i) => (
        <details key={s.anchor} id={`sec-${s.anchor}`} open={secs.length <= 8 && i < 8} className="rounded border border-border px-3 py-1" style={{ marginLeft: `${(s.level - 1) * 0.75}rem` }}>
          <summary className="cursor-pointer text-sm font-medium">{s.title} <span className="text-xs text-subtle">#{s.anchor}</span></summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-sm text-fg-soft">{body.slice(s.start, s.end).split("\n").slice(1).join("\n").trim()}</pre>
        </details>))}</div>
    </Card>
  );
}

async function Body({ u, params }: { u: Actor; params: PageProps<"/agents/skills/[id]">["params"] }) {
  const r = detail(getDb(), u, (await params).id);
  if (r.status === 404) notFound();
  const d = r.body as D, s = d.skill;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{s.name}</h2><span className="text-sm text-subtle">v{s.version}</span>
        {s.kind === "master" ? <Badge tone="violet">master skill</Badge> : <Badge>SOP skill</Badge>}<StatusBadge status={d.approval.status} />
        {u.role === "admin" && <Badge tone="blue">team: {d.summary.team}</Badge>}
        {d.can.edit && <Link href={`/agents/skills/${s.id}/edit`} className="ml-auto rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-surface-2">Edit</Link>}
      </div>
      {s.description ? <p className="text-sm text-fg-soft">{s.description}</p> : <p className="text-sm text-subtle">No description.</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Run" subtitle="Simulated runs are dry runs (agents and GitHub simulated, shell and approval steps not executed) and need no approval">
          {d.effective.errors.length ? <p className="text-sm text-danger">{d.effective.errors[0]}</p> : <RunSkill id={s.id} inputs={s.plan.inputs as never} approved={d.approval.status === "approved"} />}
        </Card>
        <Card title="Approval" subtitle={<>Effective hash <C>{d.effective.hash.slice(0, 12)}</C> covers the SOP, plan, composed skills and agents</>}>
          <p className="text-sm"><StatusBadge status={d.approval.status} /> <span className="text-muted">{d.approval.reason}</span></p>
          {d.approval.decisions.length > 0 && <ul className="mt-2 text-xs text-fg-soft">{d.approval.decisions.map((x, i) => <li key={i}>{x.decision} by {x.email} ({x.role}) {x.comment && `“${x.comment}”`} · {when(x.createdAt)}</li>)}</ul>}
          <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">Hash parts</summary><ul className="mt-1 font-mono">{d.effective.parts.map((p) => <li key={p}>{p.slice(0, 80)}</li>)}</ul></details>
          {d.can.approve && d.approval.status !== "approved" && <div className="mt-3"><Approve id={s.id} /></div>}
        </Card>
      </div>
      {(d.composed.length > 0 || d.composeError) && <Card title="Composed skills" subtitle="call_skill targets (recursive); each runs as its own run with its own audit trail">
        {d.composeError && <p className="text-sm text-danger">{d.composeError}</p>}
        <ul className="text-sm">{d.composed.map((k) => <li key={k.id}><Link className="text-success hover:underline" href={`/agents/skills/${k.id}`}>{k.name}</Link> <span className="text-subtle">v{k.version}</span></li>)}</ul></Card>}
      <PlanView s={s} />
      <SopView body={s.body} />
      <Card title="Runs" subtitle="Latest 20">
        {d.runs.length ? <ul className="space-y-1 text-sm">{d.runs.map((x) => <li key={x.id}><Link className="font-mono text-success hover:underline" href={`/runs/${x.id}`}>{x.id}</Link> <StatusBadge status={x.status} /> <span className="text-xs text-muted">{x.mode} · {x.triggeredBy} · {when(x.startedAt)}</span></li>)}</ul> : <p className="text-sm text-muted">No runs yet.</p>}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Versions"><ul className="space-y-1 text-xs">{d.versions.map((v) => <li key={v.version}>v{v.version} <C>{v.hash.slice(0, 12)}</C> {v.note} · {v.savedBy ?? "built-in"} · {when(v.savedAt)}</li>)}</ul></Card>
        {d.audit.length > 0 && <Card title="Audit"><ul className="space-y-1 text-xs">{d.audit.map((a, i) => <li key={i}>{when(a.at)} · {a.actor} · <b>{a.action}</b> {a.detail}</li>)}</ul></Card>}
      </div>
    </div>
  );
}
