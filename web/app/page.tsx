import Link from "next/link";
import { AgentBadge, ReviewBadge, RunStatusBadge } from "@/components/badges";
import { ExternalIcon } from "@/components/icons";
import { Badge, Card, ExampleDataBanner, Stat } from "@/components/ui";
import { agents, runs, team, weekStats } from "@/lib/mock-data";
import { AGENT_LABEL } from "@/lib/types";
import { Suspense } from "react";
import { LiveAuthBadge } from "@/components/live-config";

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Factory output</h1>
          <p className="text-sm text-zinc-400">Approved issues → agent PRs → human review. Nothing auto-merges.</p>
        </div>
        <Link href="/runs/new" className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400">New test run</Link>
      </div>
      <ExampleDataBanner />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Runs this week" value={weekStats.runsThisWeek} hint="across all repos" />
        <Stat label="PRs opened" value={weekStats.prsOpened} hint="this week" />
        <Stat label="Awaiting review" value={weekStats.awaitingReview} hint="needs a human" />
      </div>

      <Card title="Recent runs" subtitle="What the factory built and where it is in review">
        <ul className="divide-y divide-zinc-800 md:hidden">
          {runs.map((r) => (
            <li key={r.id} className="space-y-2 py-3">
              <p className="font-medium">#{r.issue} {r.title}</p>
              <p className="text-sm text-zinc-400">{r.summary}</p>
              <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
                <AgentBadge agent={r.agent} /><ReviewBadge status={r.review} /><span>{r.repo}</span><span>· {r.when}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="-mx-5 hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-5 pb-3 font-medium">What got built</th>
                <th className="px-3 pb-3 font-medium">Repo</th>
                <th className="px-3 pb-3 font-medium">Agent</th>
                <th className="px-3 pb-3 font-medium">Run</th>
                <th className="px-3 pb-3 font-medium">Review</th>
                <th className="px-3 pb-3 font-medium">PR</th>
                <th className="px-5 pb-3 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {runs.map((r) => (
                <tr key={r.id} className="align-top hover:bg-zinc-800/30">
                  <td className="max-w-md px-5 py-3">
                    <p className="font-medium text-zinc-100"><span className="text-zinc-500">#{r.issue}</span> {r.title}</p>
                    <p className="mt-0.5 text-xs text-zinc-400">{r.summary}</p>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-zinc-300">{r.repo}</td>
                  <td className="px-3 py-3"><AgentBadge agent={r.agent} /></td>
                  <td className="px-3 py-3"><RunStatusBadge status={r.runStatus} /><p className="mt-1 text-xs text-zinc-500">{r.durationMin} min</p></td>
                  <td className="px-3 py-3"><ReviewBadge status={r.review} /></td>
                  <td className="px-3 py-3">
                    {r.pr ? (
                      <a href="#" title="PR link placeholder" className="inline-flex items-center gap-1 text-sky-400 hover:underline">#{r.pr}<ExternalIcon className="h-3 w-3" /></a>
                    ) : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3 text-right text-xs text-zinc-500">{r.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Agent activity" subtitle="Claude Code and Codex drivers">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {agents.map((a) => (
              <div key={a.agent} className="rounded-lg border border-zinc-800 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{AGENT_LABEL[a.agent]}</p>
                  <Suspense fallback={null}><LiveAuthBadge agent={a.agent} /></Suspense>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
                  <dt className="text-zinc-500">Active jobs</dt><dd className="text-right tabular-nums">{a.activeJobs}</dd>
                  <dt className="text-zinc-500">Runs (week)</dt><dd className="text-right tabular-nums">{a.runsThisWeek}</dd>
                  <dt className="text-zinc-500">Success rate</dt><dd className="text-right tabular-nums">{Math.round(a.successRate * 100)}%</dd>
                  <dt className="text-zinc-500">Last run</dt><dd className="text-right">{a.lastRun}</dd>
                </dl>
                <div className="mt-3 h-1.5 rounded-full bg-zinc-800">
                  <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${a.successRate * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Team" subtitle="Who approves issues and reviews agent PRs">
          <ul className="divide-y divide-zinc-800">
            {team.map((m) => (
              <li key={m.name} className="flex items-center gap-3 py-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold">
                  {m.name.split(" ").map((p) => p[0]).join("")}
                </span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{m.name}</p>
                  <p className="text-xs text-zinc-500">{m.role} · {m.openReviews} open reviews</p>
                </div>
                <Badge tone={m.status === "online" ? "green" : m.status === "reviewing" ? "blue" : "gray"} dot>{m.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
