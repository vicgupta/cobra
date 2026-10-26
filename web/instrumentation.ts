// Next.js startup hook: the daily system-admin notification scheduler (Node runtime, production only).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { startNotifyScheduler } = await import("./lib/notify-scheduler");
    startNotifyScheduler();
  }
}
