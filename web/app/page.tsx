import Link from "next/link";
import { Suspense } from "react";
import { AuthBadge } from "@/components/badges";
import { Card, Stat } from "@/components/ui";
import { AuthGate } from "@/components/auth-gate";
import { canUseSharedConfig, type SessionUser } from "@/lib/auth/sessions";
import { getDb } from "@/lib/db";
import { agentModes } from "@/lib/env-file";
import { listRecentRunRows, listRunsWithTime } from "@/lib/runs-db";
import { RecentRunsTable } from "@/components/recent-runs-table";
import { AGENT_LABEL, type AgentId } from "@/lib/types";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const AGENTS: AgentId[] = ["claude-code", "codex"];

/** Rows from the retired Settings > Test run (workflow test-run, or pre-workflow rows). Kept, never deleted. */
function isLegacyTestRun(r: { workflow?: string | null }): boolean {
  return !r.workflow || r.workflow === "test-run";
}

function ago(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export default function Dashboard() {
  return (
    <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}>
      <AuthGate>{(u) => <DashboardBody user={u} />}</AuthGate>
    </Suspense>
  );
}

async function DashboardBody({ user }: { user: SessionUser }) {
  const shared = canUseSharedConfig(user);
  // Every member of the tenant sees its runs (workflow and skill runs; legacy test-run rows are labeled); agent status stays admin-only.
  const { now, runs } = listRunsWithTime(user.tenantId);
  const rows = listRecentRunRows(user.tenantId, 25);
  const real = runs.filter((r) => !isLegacyTestRun(r));
  const week = real.filter((r) => now - r.startedAt < WEEK);
  const modes = shared ? await agentModes() : null;
  const team = getDb().prepare("SELECT name, email, role FROM users WHERE tenant_id = ? ORDER BY created_at").all(user.tenantId) as
    Array<{ name: string; email: string; role: string }>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Factory output</h1>
          <p className="text-sm text-muted">Approved issues → agent PRs → human review. Nothing auto-merges.</p>
        </div>
        <Link href="/skills" className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">Run a skill</Link>
      </div>

      {(
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Runs this week" value={week.length} hint="workflow and skill runs" />
            <Stat label="PRs opened" value="—" hint="no real runs yet" />
            <Stat label="Awaiting review" value="—" hint="no real runs yet" />
          </div>

          <Card title="Recent runs" subtitle="Latest workflow and skill runs">
            {rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-subtle">No runs yet. <Link href="/skills" className="text-accent hover:underline">Run a skill</Link>.</p>
            ) : (
              <RecentRunsTable runs={rows} now={now} />
            )}
          </Card>
        </>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {shared && modes && (
          <Card title="Agents" subtitle="Sign-in mode from the server environment file">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {AGENTS.map((a) => {
                const mine = real.filter((r) => r.agent === a);
                return (
                  <div key={a} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">{AGENT_LABEL[a]}</p>
                      <AuthBadge mode={modes[a]} />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
                      <dt className="text-subtle">Runs this week</dt><dd className="text-right tabular-nums">{week.filter((r) => r.agent === a).length}</dd>
                      <dt className="text-subtle">Last run</dt><dd className="text-right">{mine[0] ? ago(now - mine[0].startedAt) : "—"}</dd>
                    </dl>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <Card title="Team" subtitle={`Members of ${user.tenantName}`}>
          <ul className="divide-y divide-border">
            {team.map((m) => (
              <li key={m.email} className="flex items-center gap-3 py-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold">
                  {(m.name || m.email).split(/\s+/).map((p) => p[0]?.toUpperCase()).join("").slice(0, 2)}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{m.name || m.email}</p>
                  <p className="text-xs text-subtle">{m.role}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
