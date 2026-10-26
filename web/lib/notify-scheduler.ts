// In-app scheduler for the daily system-admin email: checks once a minute; maybeSendDaily records each
// send in notification_sends and its unique per-day index prevents double sends. Started from
// instrumentation.ts in the Node runtime only (disable with COBRA_NOTIFY_SCHEDULER=off).
import { dbPath, getDb } from "./db";
import { sendEmail } from "./mail";
import { maybeSendDaily, serviceHealth } from "./notifications";
import { maybeRunDailyUpdate } from "./tool-updates";
import { nodeOps } from "./tool-updates-node";

const g = globalThis as { __cobraNotifyTimer?: ReturnType<typeof setInterval> };

export function startNotifyScheduler(): void {
  if (g.__cobraNotifyTimer || process.env.COBRA_NOTIFY_SCHEDULER === "off") return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // 4:00 AM ET agent-tool updates (disable with COBRA_UPDATE_SCHEDULER=off), then the 7 AM email.
      if (process.env.COBRA_UPDATE_SCHEDULER !== "off") {
        const u = await maybeRunDailyUpdate(getDb(), nodeOps, Date.now());
        if (!["not-due", "already", "busy", "waiting"].includes(u)) console.log(`[cobra] daily tool update: ${u}`);
      }
    } catch (e) { console.error("[cobra] daily tool update:", e instanceof Error ? e.message : e); }
    try {
      const r = await maybeSendDaily(getDb(), sendEmail, Date.now(), () => serviceHealth(dbPath(), "/var/lib/cobra"));
      if (r === "sent" || r === "failed") console.log(`[cobra] daily admin email: ${r}`);
    } catch (e) { console.error("[cobra] daily admin email:", e instanceof Error ? e.message : e); } finally { busy = false; }
  };
  g.__cobraNotifyTimer = setInterval(() => void tick(), 60_000);
  g.__cobraNotifyTimer.unref?.();
  setTimeout(() => void tick(), 15_000).unref?.();
}
