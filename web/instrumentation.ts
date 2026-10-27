// Next.js startup hook: the daily system-admin notification scheduler and the team-agent cron (Node runtime, production only).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { startNotifyScheduler } = await import("./lib/notify-scheduler");
    startNotifyScheduler();
    // Team-agent cron (off per agent unless enabled; COBRA_AGENT_SCHEDULER=off disables it entirely).
    const { startAgentScheduler } = await import("./lib/agent-scheduler");
    startAgentScheduler();
  }
}
