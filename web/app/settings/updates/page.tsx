import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { UpdatesForm } from "@/components/updates-form";
import { isSystemAdmin } from "@/lib/collab";
import { getDb } from "@/lib/db";
import { fmtNy, listNotificationAudit } from "@/lib/notifications";
import { getUpdateRun, listUpdateRuns, nextScheduled, updateSettings } from "@/lib/tool-updates";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Updates · Settings · Cobra" };

const RESULT_TONE = { changed: "blue", unchanged: "gray", rolled_back: "amber", failed: "red", skipped: "gray" } as const;
const STATUS_TONE = { ok: "green", partial: "amber", failed: "red", skipped: "gray", running: "blue", waiting: "blue" } as const;
const label = (s: string) => s.replace("_", " ");

/** Settings > Updates: daily agent-tool updates as before/after snapshots (system admins only). */
export default function SettingsUpdatesPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  return <CollabPage title="Updates">{(u) => <Body u={u} searchParams={searchParams} />}</CollabPage>;
}

async function Body({ u, searchParams }: { u: Actor; searchParams: Promise<{ run?: string }> }) {
  if (!isSystemAdmin(u)) notFound();
  const sel = Number((await searchParams).run) || undefined;
  const db = getDb(), s = updateSettings(db), runs = listUpdateRuns(db, 60), run = getUpdateRun(db, sel);
  const running = runs.some((r) => r.status === "running");
  const audit = listNotificationAudit(db, 40).filter((a) => a.action.startsWith("updates_")).slice(0, 10);
  return (
    <div className="space-y-6">
      <Card title="Agent tool updates" subtitle={`Daily at 4:00 AM America/New_York (DST-aware). Waits for active agent runs (every 15 min until 6:30 AM ET, then skips). ${s.updatedBy ? `Last changed ${fmtNy(s.updatedAt!)} by ${s.updatedBy}.` : ""}`}>
        <div className="space-y-3 text-sm">
          <p data-updates-status={s.enabled ? "on" : "off"}>Status: {s.enabled ? "On" : "Off"} · Next scheduled: {s.enabled ? fmtNy(nextScheduled(db)) : "—"}</p>
          <p data-last-update>Last run: {runs[0] ? <>{fmtNy(runs[0].startedAt ?? runs[0].createdAt)} ({runs[0].kind}) <Badge tone={STATUS_TONE[runs[0].status as keyof typeof STATUS_TONE] ?? "gray"}>{runs[0].status}</Badge>{runs[0].reason ? ` ${runs[0].reason}` : ""}</> : "never"}</p>
          <p className="text-xs text-subtle">CLIs are installed to a staging prefix and smoke-tested with --version before an atomic swap; the previous version is kept and restored if the new one fails. Model catalogs are read-only snapshots. OpenRouter is on hold and not refreshed.</p>
          <UpdatesForm enabled={s.enabled} running={running} />
        </div>
      </Card>
      <Card title={run ? `Before / after: ${run.runDate} (${run.kind}${run.triggeredBy && run.kind === "manual" ? ` by ${run.triggeredBy}` : ""})` : "Before / after"} subtitle={run ? `${run.startedAt ? `Started ${fmtNy(run.startedAt)}` : `Claimed ${fmtNy(run.createdAt)}`}${run.finishedAt ? ` · finished ${fmtNy(run.finishedAt)}` : ""} · ${run.status}${run.reason ? ` · ${run.reason}` : ""}` : "No updates have run yet."}>
        {run && (run.items.length ? (
          <table className="w-full text-sm" data-update-compare>
            <thead><tr className="text-left text-xs text-subtle"><th className="py-2">Tool</th><th>Before</th><th>After</th><th>Result</th><th>Time</th><th>Details</th></tr></thead>
            <tbody className="divide-y divide-border">{run.items.map((i, k) => (
              <tr key={k} data-update-tool={i.tool}>
                <td className="py-2 font-medium">{i.label}<div className="text-xs font-normal text-subtle">{i.method}</div></td>
                <td className="font-mono text-xs">{i.before ?? "—"}</td>
                <td className="font-mono text-xs">{i.after ?? "—"}</td>
                <td><Badge tone={RESULT_TONE[i.result as keyof typeof RESULT_TONE] ?? "gray"}>{label(i.result)}</Badge></td>
                <td className="whitespace-nowrap text-xs text-muted">{fmtNy(i.at)}</td>
                <td className="text-xs text-muted">{i.detail}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p className="text-sm text-subtle">{run.status === "running" || run.status === "waiting" ? "In progress…" : "No tools were checked in this run."}</p>)}
      </Card>
      <Card title="History" subtitle="Every run is kept as a before/after snapshot. Pick one to compare.">
        <ul className="space-y-1 text-xs" data-update-history>{runs.length ? runs.map((r) => (
          <li key={r.id}><Link className={`hover:underline ${run?.id === r.id ? "font-semibold" : "text-info"}`} href={`/settings/updates?run=${r.id}`}>{r.runDate} · {r.kind} · {fmtNy(r.startedAt ?? r.createdAt)}</Link> · {r.status}{r.reason ? ` (${r.reason})` : ""}</li>
        )) : <li className="text-subtle">None yet</li>}</ul>
      </Card>
      <Card title="Audit">
        <ul className="space-y-1 text-xs" data-updates-audit>{audit.length ? audit.map((a, i) => <li key={i}>{fmtNy(a.at)} · {a.actorEmail} · {a.detail}</li>) : <li className="text-subtle">No changes yet</li>}</ul>
      </Card>
    </div>
  );
}
