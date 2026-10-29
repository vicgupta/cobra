import Link from "next/link";

/** The Agents section toggle: "Agents | Skills | Lessons" (one page each, no submenu). */
export function AgentsTabs({ active }: { active: "agents" | "skills" | "lessons" }) {
  const tab = (href: string, label: string, on: boolean) => (
    <Link href={href} aria-current={on ? "page" : undefined} data-tab={label}
      className={`rounded-md px-3 py-1.5 text-sm ${on ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg"}`}>{label}</Link>
  );
  return (
    <nav aria-label="Agents section" className="inline-flex gap-1 rounded-lg border border-border p-1" data-testid="agents-tabs">
      {tab("/agents", "Agents", active === "agents")}
      {tab("/agents/skills", "Skills", active === "skills")}
      {tab("/agents/lessons", "Lessons", active === "lessons")}
    </nav>
  );
}
