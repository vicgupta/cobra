/** Tasks section tabs. Current is the default; Templates is the automation library. */
export type TasksTab = "current" | "templates";

export function parseTasksTab(raw: string | undefined): TasksTab {
  return raw === "templates" ? "templates" : "current";
}
