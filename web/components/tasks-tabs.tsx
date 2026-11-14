import Link from "next/link";
import type { TasksTab } from "@/lib/tasks-tabs";

export type { TasksTab };

export function TasksTabs({ active }: { active: TasksTab }) {
  const tab = (href: string, label: string, on: boolean) => (
    <Link href={href} aria-current={on ? "page" : undefined} data-tab={label}
      className={`rounded-md px-3 py-1.5 text-sm ${on ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface hover:text-fg"}`}>{label}</Link>
  );
  return (
    <nav aria-label="Tasks" className="flex flex-wrap gap-1 border-b border-border pb-2 text-sm" data-testid="tasks-tabs">
      {tab("/tasks", "Current", active === "current")}
      {tab("/tasks?tab=templates", "Templates", active === "templates")}
    </nav>
  );
}
