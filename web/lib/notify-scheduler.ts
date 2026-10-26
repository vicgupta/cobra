// In-app scheduler for the daily system-admin email: checks once a minute; maybeSendDaily records each
// send in notification_sends and its unique per-day index prevents double sends. Started from
// instrumentation.ts in the Node runtime only (disable with COBRA_NOTIFY_SCHEDULER=off).
import { dbPath, getDb } from "./db";
import { sendEmail } from "./mail";
import { maybeSendDaily, serviceHealth } from "./notifications";

const g = globalThis as { __cobraNotifyTimer?: ReturnType<typeof setInterval> };

export function startNotifyScheduler(): void {
  if (g.__cobraNotifyTimer || process.env.COBRA_NOTIFY_SCHEDULER === "off") return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await maybeSendDaily(getDb(), sendEmail, Date.now(), () => serviceHealth(dbPath(), "/var/lib/cobra"));
      if (r === "sent" || r === "failed") console.log(`[cobra] daily admin email: ${r}`);
    } catch (e) { console.error("[cobra] daily admin email:", e instanceof Error ? e.message : e); } finally { busy = false; }
  };
  g.__cobraNotifyTimer = setInterval(() => void tick(), 60_000);
  g.__cobraNotifyTimer.unref?.();
  setTimeout(() => void tick(), 15_000).unref?.();
}
