import Link from "next/link";
import { Suspense } from "react";
import { AgentBadge, AuthBadge } from "@/components/badges";
import { Badge, Card, Stat } from "@/components/ui";
import { AuthGate } from "@/components/auth-gate";
import { canUseSharedConfig, type SessionUser } from "@/lib/auth/sessions";
import { getDb } from "@/lib/db";
import { agentModes } from "@/lib/env-file";
import { listRunsWithTime } from "@/lib/runs-db";
import { STEP_LABEL, stepAt } from "@/lib/runs";
import { AGENT_LABEL, type AgentId } from "@/lib/types";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const AGENTS: AgentId[] = ["claude-code", "codex"];

function ago(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export default function Dashboard() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <AuthGate>{(u) => <DashboardBody user={u} />}</AuthGate>
    </Suspense>
  );
}

async function DashboardBody({ user }: { user: SessionUser }) {
  const shared = canUseSharedConfig(user);
  // Every member of the tenant sees its runs; starting runs and agent status stay admin-only.
  const { now, runs } = listRunsWithTime(user.tenantId);
  const week = runs.filter((r) => now - r.startedAt < WEEK);
  const modes = shared ? await agentModes() : null;
  const team = getDb().prepare("SELECT name, email, role FROM users WHERE tenant_id = ? ORDER BY created_at").all(user.tenantId) as
    Array<{ name: string; email: string; role: string }>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Factory output</h1>
          <p className="text-sm text-zinc-400">Approved issues → agent PRs → human review. Nothing auto-merges.</p>
        </div>
        {shared && <Link href="/runs/new" className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">New test run</Link>}
      </div>

      {(
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Runs this week" value={week.length} hint="simulated test runs" />
            <Stat label="PRs opened" value="—" hint="no real runs yet" />
            <Stat label="Awaiting review" value="—" hint="no real runs yet" />
          </div>

          <Card title="Recent runs" subtitle="Simulated test runs so far; real agent runs will appear here">
            {runs.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">No runs yet.{shared && <> <Link href="/runs/new" className="text-emerald-400 hover:underline">Start a test run</Link>.</>}</p>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {runs.slice(0, 15).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
                    <Link href={`/runs/${r.id}`} className="font-medium hover:underline">{r.issue > 0 && <span className="text-zinc-500">#{r.issue} </span>}{r.title}</Link>
                    {r.repo && <span className="font-mono text-xs text-zinc-400">{r.repo}</span>}
                    {r.workflow && r.workflow !== "test-run" ? (
                      <><Badge tone="violet">{r.workflow}</Badge><Badge tone="gray" dot>{r.status ?? "unknown"}</Badge></>
                    ) : (
                      <><AgentBadge agent={r.agent} /><Badge tone="gray" dot>{STEP_LABEL[stepAt(r, now)]}</Badge><Badge tone="amber">Simulated</Badge></>
                    )}
                    <span className="ml-auto text-xs text-zinc-500">{ago(now - r.startedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {shared && modes && (
          <Card title="Agents" subtitle="Sign-in mode from the server environment file">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {AGENTS.map((a) => {
                const mine = runs.filter((r) => r.agent === a);
                return (
                  <div key={a} className="rounded-lg border border-zinc-800 p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{AGENT_LABEL[a]}</p>
                      <AuthBadge mode={modes[a]} />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
                      <dt className="text-zinc-500">Test runs (week)</dt><dd className="text-right tabular-nums">{week.filter((r) => r.agent === a).length}</dd>
                      <dt className="text-zinc-500">Last run</dt><dd className="text-right">{mine[0] ? ago(now - mine[0].startedAt) : "—"}</dd>
                    </dl>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <Card title="Team" subtitle={`Members of ${user.tenantName}`}>
          <ul className="divide-y divide-zinc-800">
            {team.map((m) => (
              <li key={m.email} className="flex items-center gap-3 py-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold">
                  {(m.name || m.email).split(/\s+/).map((p) => p[0]?.toUpperCase()).join("").slice(0, 2)}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{m.name || m.email}</p>
                  <p className="text-xs text-zinc-500">{m.role}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
