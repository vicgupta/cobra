import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { requireAdmin } from "@/lib/auth/server";
import { getDb } from "@/lib/db";
import * as m from "@/lib/admin/metrics";
import { parseRange } from "@/lib/usage";
import { UsageView } from "@/components/usage-view";
import { loadWorkflows } from "@/lib/workflows/loader";
import { Badge, Card, Stat, type Tone } from "@/components/ui";
import { EndSessionButton } from "@/components/admin-actions";
import { SettingsForm } from "@/components/settings-form";
import { GithubForm } from "@/components/github-form";
import { EnvFilePath } from "@/components/live-config";
import { TemplatesView } from "@/components/templates";

export const metadata = { title: "Admin · Cobra" };

const TABS = [
  ["overview", "Overview"], ["tenants", "Tenants"], ["users", "Users"], ["sessions", "Sessions"], ["workflows", "Workflows"],
  ["logs", "Execution logs"], ["approvals", "Approvals"], ["rate-limits", "Rate limiting"], ["usage", "Usage"], ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function AdminPage({ searchParams }: PageProps<"/admin">) {
  return (
    <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}>
      <AdminBody searchParams={searchParams} />
    </Suspense>
  );
}

async function AdminBody({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  await requireAdmin();
  const sp = await searchParams;
  const raw = sp.tab;
  const tab: Tab = (TABS.find(([k]) => k === raw)?.[0] ?? "overview");
  const now = m.clock();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted">System-wide view across all tenants. Read-only except Settings and ending sessions.</p>
      </div>
      <nav className="flex flex-wrap gap-1 border-b border-border pb-2 text-sm">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/admin?tab=${k}`} className={`rounded-md px-3 py-1.5 ${k === tab ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg"}`}>{label}</Link>
        ))}
      </nav>
      {tab === "overview" && <Overview now={now} />}
      {tab === "tenants" && <Tenants />}
      {tab === "users" && <Users now={now} />}
      {tab === "sessions" && <Sessions now={now} />}
      {tab === "workflows" && <Workflows />}
      {tab === "logs" && <Logs />}
      {tab === "approvals" && <Approvals />}
      {tab === "rate-limits" && <RateLimits now={now} />}
      {tab === "usage" && <UsageView range={parseRange(sp.range)} page={Number(sp.page) || 1} tenantId={null} base="/admin?tab=usage" />}
      {tab === "settings" && <SettingsTabs sub={sp.sub === "templates" ? "templates" : "system"} />}
    </div>
  );
}

const dt = (t: number | null | undefined) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
const short = (h: string | null) => (h ? h.slice(0, 12) : "—");
const statusTone = (s: string | null): Tone => (s === "succeeded" ? "green" : s === "failed" ? "red" : s === "running" || s === "queued" ? "blue" : "gray");

function Table({ head, rows, empty = "Nothing yet" }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-subtle">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-subtle"><tr>{head.map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-2 py-1.5 align-top text-fg-soft">{c}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ now }: { now: number }) {
  const db = getDb();
  const o = m.overview(db, now);
  const repo = loadWorkflows().workflows.length;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Tenants" value={o.tenants} />
        <Stat label="Users" value={o.users} hint={o.usersByRole.map((r) => `${r.c} ${r.role}`).join(" · ")} />
        <Stat label="Active sessions" value={o.activeSessions} hint={`${o.activeUsers24h} users active in 24 h`} />
        <Stat label="Runs" value={o.runs} hint={`${o.runs24h} in 24 h · ${o.runs7d} in 7 d`} />
        <Stat label="Tenant workflows" value={o.tenantWorkflows} hint={`${o.instances} from templates · ${o.githubStored} on GitHub`} />
        <Stat label="Templates" value={o.systemTemplates + o.tenantTemplates} hint={`${o.systemTemplates} system · ${o.tenantTemplates} workspace`} />
        <Stat label="Repo workflows" value={repo} />
        <Stat label="Approval decisions" value={o.approvals} />
        <Stat label="Rate-limit entries" value={o.rateLimitedNow} hint="in the current windows" />
        <Stat label="Pending password resets" value={o.pendingResets} />
        <Stat label="DB schema" value={`v${o.schemaVersion}`} />
        <Stat label="Node" value={process.version} hint={`up ${Math.round(process.uptime() / 60)} min`} />
      </div>
      <Card title="Runs by status">
        <div className="flex flex-wrap gap-2">{o.runsByStatus.map((s) => <Badge key={s.status} tone={statusTone(s.status)}>{s.status}: {s.c}</Badge>)}{!o.runsByStatus.length && <span className="text-sm text-subtle">No runs yet</span>}</div>
      </Card>
    </div>
  );
}

function Tenants() {
  return <Card title="Tenants"><Table head={["Name", "Slug", "Created", "Users", "Admins", "Workflows", "Runs", "Last run"]}
    rows={m.tenants(getDb()).map((t) => [t.name, <code key="s">{t.slug}</code>, dt(t.created_at), t.users, t.admins, t.workflows, t.runs, dt(t.last_run)])} /></Card>;
}

function Users({ now }: { now: number }) {
  return <Card title="Users" subtitle="All tenants"><Table head={["Email", "Name", "Tenant", "Role", "Created", "Active sessions", "Last seen", "Runs"]}
    rows={m.users(getDb(), now).map((u) => [u.email, u.name || "—", u.tenant, <Badge key="r" tone={u.role === "admin" ? "violet" : u.role === "team_lead" ? "blue" : "gray"}>{u.role}</Badge>, dt(u.created_at), u.sessions, dt(u.last_seen), u.runs])} /></Card>;
}

function Sessions({ now }: { now: number }) {
  return <Card title="Active sessions" subtitle="Ending a session signs that device out immediately."><Table head={["User", "Tenant", "Started", "Last seen", "Expires", "Remember", "IP", "Browser", ""]}
    rows={m.sessions(getDb(), now).map((s) => [s.email, s.tenant, dt(s.created_at), dt(s.last_seen_at ?? s.created_at), dt(s.expires_at), s.remember ? "30 d" : "12 h", s.ip || "—",
      <span key="ua" className="block max-w-xs truncate text-xs text-subtle" title={s.user_agent}>{s.user_agent || "—"}</span>, <EndSessionButton key="e" id={s.public_id} />])} /></Card>;
}

function Workflows() {
  const db = getDb();
  const { workflows: repo, errors } = loadWorkflows();
  return (
    <div className="space-y-6">
      <Card title="Tenant workflows and templates"><Table head={["Tenant", "Name", "Kind", "Storage", "From template", "Version", "Approvals", "Runs", "Last run", "Created by", "Updated"]}
        rows={m.workflows(db).map((w) => [w.tenant, w.name, w.is_template ? <Badge key="k" tone="violet">template</Badge> : "workflow",
          w.storage === "github" ? <span key="g" className="text-xs">github: {w.github_repo}/{w.github_path}</span> : "database", w.template_name ?? "—", <code key="h">{short(w.content_hash)}</code>,
          w.rejections ? <Badge key="a" tone="red">{w.approvals} ✓ / {w.rejections} ✗</Badge> : <Badge key="a" tone={w.approvals ? "green" : "amber"}>{w.approvals} ✓</Badge>, w.runs, dt(w.last_run), w.created_by ?? "—", dt(w.updated_at)])} /></Card>
      <Card title="Repo workflows" subtitle={errors.length ? `Shipped in workflows/*.yaml · ${errors.length} invalid file(s): ${errors.map((e) => e.file).join(", ")}` : "Shipped in workflows/*.yaml"}><Table head={["Name", "Version", "Owner", "Steps", "Version hash"]}
        rows={repo.map((w) => [w.workflow.name, w.workflow.version, w.workflow.governance.owner, w.workflow.steps.length, <code key="h">{short(w.hash)}</code>])} /></Card>
      <Card title="System templates"><Table head={["Name", "Version", "Hash", "Seeded", "Instances"]}
        rows={m.systemTemplates(db).map((t) => [t.name, t.version, <code key="h">{short(t.content_hash)}</code>, dt(t.created_at), t.instances])} /></Card>
      <Card title="Runs per workflow"><Table head={["Workflow", "Runs", "Succeeded", "Failed"]} rows={m.runsByWorkflow(db).map((r) => [r.workflow, r.runs, r.succeeded ?? 0, r.failed ?? 0])} /></Card>
    </div>
  );
}

function Logs() {
  const runs = m.executionLogs(getDb(), 50);
  if (!runs.length) return <Card title="Execution logs"><p className="text-sm text-subtle">No runs yet</p></Card>;
  return (
    <Card title="Execution logs" subtitle="Latest 50 runs across all tenants. Outputs were redacted and capped when stored.">
      <div className="space-y-2">
        {runs.map((r) => (
          <details key={r.id} className="rounded-lg border border-border px-3 py-2">
            <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm">
              <code className="text-xs">{r.id}</code><Badge tone={statusTone(r.status)}>{r.status ?? "legacy"}</Badge>
              <span>{r.workflow ?? "—"}</span><span className="text-subtle">{r.tenant} · {r.email ?? "deleted user"} · {dt(r.started_at)}{r.ended_at ? ` · ${((r.ended_at - r.started_at) / 1000).toFixed(1)} s` : ""}</span>
            </summary>
            {r.error && <p className="mt-2 text-xs text-danger">{r.error}</p>}
            <Table head={["At", "Step", "Status", "Attempt", "Output"]} empty="No step events (legacy run)"
              rows={r.events.map((e) => [dt(e.at), e.step_id, <Badge key="s" tone={statusTone(e.status)}>{e.status}</Badge>, e.attempt,
                e.output ? <pre key="o" className="max-h-40 max-w-xl overflow-auto whitespace-pre-wrap text-xs text-muted">{e.output}{e.truncated ? "\n… (truncated)" : ""}</pre> : "—"])} />
          </details>
        ))}
      </div>
    </Card>
  );
}

function Approvals() {
  return <Card title="Approval decisions" subtitle="Latest 100. 'Current' means the decision applies to the workflow's current version."><Table head={["When", "Tenant", "Workflow", "Version", "By", "Decision", "Current", "Comment"]}
    rows={m.approvals(getDb()).map((a) => [dt(a.created_at), a.tenant, a.workflow, <code key="h">{short(a.content_hash)}</code>, a.email,
      <Badge key="d" tone={a.decision === "approve" ? "green" : "red"}>{a.decision}</Badge>, a.current ? "yes" : "no", a.comment || "—"])} /></Card>;
}

function RateLimits({ now }: { now: number }) {
  const r = m.rateLimits(getDb(), now);
  return (
    <div className="space-y-6">
      <Card title="Limits" subtitle="Fixed windows; counts reset when a window expires."><Table head={["Bucket", "Max", "Window", "Keys tracked", "Blocked now"]}
        rows={r.limits.map((l) => [l.bucket, l.max, `${l.windowMs / 60000} min`, l.tracked, l.blocked ? <Badge key="b" tone="red">{l.blocked}</Badge> : 0])} /></Card>
      <Card title="Current entries" subtitle="Account and email keys are sha256 hashes; IP keys are client IPs."><Table head={["Bucket", "Key", "Count", "Window start", "Expires"]}
        rows={r.rows.map((x) => [x.bucket, <code key="k" className="text-xs">{x.key.length > 24 ? x.key.slice(0, 16) + "…" : x.key}</code>, x.max && x.count >= x.max ? <Badge key="c" tone="red">{x.count}/{x.max}</Badge> : `${x.count}/${x.max ?? "?"}`, dt(x.window_start), dt(x.expires_at)])} /></Card>
    </div>
  );
}

function SettingsTabs({ sub }: { sub: "system" | "templates" }) {
  const tabs = [["system", "System settings", "/admin?tab=settings"], ["templates", "Templates", "/admin?tab=settings&sub=templates"]] as const;
  return (
    <div className="space-y-6">
      <nav aria-label="Admin settings" className="flex flex-wrap gap-1 border-b border-border pb-2 text-sm">
        {tabs.map(([k, label, href]) => <Link key={k} href={href} className={`rounded-md px-3 py-1.5 ${k === sub ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg"}`}>{label}</Link>)}
      </nav>
      {sub === "templates" ? <TemplatesView /> : <Settings />}
    </div>
  );
}

function Settings() {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-4 py-2 text-xs text-warning">
        Values are saved to the server environment file <EnvFilePath /> and used by the agent driver on the next run (no restart needed). Saved secrets are never sent back to the browser — only the last 4 characters.
      </div>
      <SettingsForm />
      <GithubForm />
    </div>
  );
}

