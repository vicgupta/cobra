import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { sendEmail } from "@/lib/mail";
import { dbPath, getDb } from "@/lib/db";
import { notificationStatus, sendTestNow, serviceHealth, setDailyEnabled } from "@/lib/notifications";
import { isSystemAdmin } from "@/lib/collab";

const err = (e: unknown) => { if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; };

/** Settings > Notifications (system admins only; others get 404). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  if (!isSystemAdmin(g.user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ notifications: notificationStatus(getDb()) });
}

/** { enabled: boolean } toggles the daily email; { action: "test" } sends a test to the signed-in admin only. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  if (!isSystemAdmin(g.user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = (await req.json().catch(() => null)) as { enabled?: unknown; action?: unknown } | null;
  try {
    if (b?.action === "test") return NextResponse.json({ notifications: await sendTestNow(getDb(), g.user, sendEmail, Date.now(), () => serviceHealth(dbPath(), "/var/lib/cobra")) });
    if (b && "enabled" in b) return NextResponse.json({ notifications: setDailyEnabled(getDb(), g.user, b.enabled) });
    throw new CollabError(400, "send { enabled: boolean } or { action: \"test\" }");
  } catch (e) { return err(e); }
}
