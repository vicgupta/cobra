// Repo selector for the Repos tabs that filter by ?repo= (All + each repo).
import Link from "next/link";

export function RepoSelect({ base, repos, current, all = true }: { base: string; repos: string[]; current?: string; all?: boolean }) {
  const chip = (href: string, text: string, on: boolean) => <Link key={href} href={href} className={`rounded-md px-2 py-1 text-xs ${on ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"}`}>{text}</Link>;
  return <div className="flex flex-wrap gap-1" aria-label="Repo">{all && chip(base, "All repos", !current)}{repos.map((r) => chip(`${base}?repo=${encodeURIComponent(r)}`, r, current?.toLowerCase() === r.toLowerCase()))}</div>;
}
