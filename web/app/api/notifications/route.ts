import { NextResponse } from "next/server";
import { collectSysInfo } from "@/lib/admin-sysinfo";
import { apiGuard } from "@/lib/auth/server";
import { CollabError, isSystemAdmin } from "@/lib/collab";
import { sendEmail } from "@/lib/mail";
import { dbPath, getDb } from "@/lib/db";
import { notificationStatus, sendTestNow, serviceHealth, setDailyEnabled } from "@/lib/notifications";

const err = (e: unknown) => { if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; };
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

/** Settings > Notifications, all-teams admin digest: system admins only (403 for everyone else). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  if (!isSystemAdmin(g.user)) return forbidden();
  return NextResponse.json({ notifications: notificationStatus(getDb()) });
}

/** { enabled: boolean } toggles the daily digest; { action: "test" } sends it now to the digest recipient. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  if (!isSystemAdmin(g.user)) return forbidden();
  const b = (await req.json().catch(() => null)) as { enabled?: unknown; action?: unknown } | null;
  try {
    if (b?.action === "test") return NextResponse.json({ notifications: await sendTestNow(getDb(), g.user, sendEmail, Date.now(), () => serviceHealth(dbPath(), "/var/lib/cobra"), undefined, (h) => collectSysInfo(h, dbPath())) });
    if (b && "enabled" in b) return NextResponse.json({ notifications: setDailyEnabled(getDb(), g.user, b.enabled) });
    throw new CollabError(400, "send { enabled: boolean } or { action: \"test\" }");
  } catch (e) { return err(e); }
}
