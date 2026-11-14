import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { getDb } from "@/lib/db";
import { listRunNotifications, markRunNotificationsRead, unreadRunNotificationCount } from "@/lib/run-notifications";

/** The current user's run notifications (this team only). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const db = getDb(), u = g.user;
  return NextResponse.json({ unread: unreadRunNotificationCount(db, u.id, u.tenantId), notifications: listRunNotifications(db, u.id, u.tenantId) });
}

/** Mark notifications read: { ids: number[] } or { all: true }. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { ids?: unknown; all?: unknown } | null;
  const db = getDb(), u = g.user;
  const ids = b?.all === true ? "all" as const : Array.isArray(b?.ids) ? (b!.ids as unknown[]).filter((n): n is number => typeof n === "number") : [];
  const read = markRunNotificationsRead(db, u.id, u.tenantId, ids);
  return NextResponse.json({ read, unread: unreadRunNotificationCount(db, u.id, u.tenantId) });
}
