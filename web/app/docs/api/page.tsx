import { readFileSync } from "node:fs";
import path from "node:path";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { PageHeader } from "@/components/page-header";
import { ListSkeleton } from "@/components/collab-view";

export const metadata = { title: "Team API docs · Cobra" };

/** Minimal renderer for docs/api.md: headings, code fences, tables, lists, paragraphs (text only, no HTML passthrough). */
function inline(s: string) {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.85em]">{p.slice(1, -1)}</code>
      : p.startsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : p);
}
function render(md: string) {
  const out: React.ReactNode[] = [], lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) { const buf: string[] = []; while (++i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i]); out.push(<pre key={i} className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{buf.join("\n")}</pre>); continue; }
    const h = /^(#{1,3}) (.*)$/.exec(l);
    if (h) { const cls = ["text-2xl font-semibold", "mt-6 text-xl font-semibold", "mt-4 text-base font-semibold"][h[1].length - 1]; out.push(<div key={i} role="heading" aria-level={h[1].length} className={cls}>{inline(h[2])}</div>); continue; }
    if (l.startsWith("|")) { const rows: string[][] = []; for (; i < lines.length && lines[i].startsWith("|"); i++) if (!/^\|[-| ]+\|$/.test(lines[i])) rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim())); i--;
      out.push(<table key={i} className="w-full text-left text-sm"><tbody>{rows.map((r, k) => <tr key={k} className="border-b border-border">{r.map((c, n) => k === 0 ? <th key={n} className="px-2 py-1">{inline(c)}</th> : <td key={n} className="px-2 py-1 align-top">{inline(c)}</td>)}</tr>)}</tbody></table>); continue; }
    if (/^\s*([-*]|\d+\.) /.test(l)) { const items: string[] = []; for (; i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, "")); i--; out.push(<ul key={i} className="list-disc space-y-1 pl-6">{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</ul>); continue; }
    if (l.trim()) out.push(<p key={i}>{inline(l)}</p>);
  }
  return out;
}
const apiDocPath = () => path.join(process.cwd(), "..", "docs", "api.md");

export default function ApiDocsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Team API" />
      <Suspense fallback={<ListSkeleton />}><AuthGate>{() => {
        let md = ""; try { md = readFileSync(apiDocPath(), "utf8"); } catch { md = "The API reference is in docs/api.md in the repository."; }
        return <article className="max-w-4xl space-y-3 text-sm leading-relaxed" data-testid="api-docs">{render(md)}</article>;
      }}</AuthGate></Suspense>
    </div>
  );
}
