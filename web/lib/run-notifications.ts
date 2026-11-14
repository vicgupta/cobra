// In-app run notifications for the header bell: team-scoped, per-user unread list.
import type { DB } from "./db";

export type RunNotification = {
  id: number; runId: string | null; taskId: number | null; title: string; body: string;
  status: "ok" | "failed"; readAt: number | null; createdAt: number;
};

type Row = { id: number; run_id: string | null; task_id: number | null; title: string; body: string; status: string; read_at: number | null; created_at: number };
const plain = (r: Row): RunNotification => ({
  id: r.id, runId: r.run_id, taskId: r.task_id, title: r.title, body: r.body,
  status: r.status === "ok" ? "ok" : "failed", readAt: r.read_at, createdAt: r.created_at,
});

export function listRunNotifications(db: DB, userId: number, tenantId: number, limit = 30): RunNotification[] {
  return (db.prepare(`SELECT id, run_id, task_id, title, body, status, read_at, created_at
    FROM run_notifications WHERE user_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT ?`).all(userId, tenantId, limit) as Row[]).map(plain);
}

export function unreadRunNotificationCount(db: DB, userId: number, tenantId: number): number {
  return (db.prepare("SELECT count(*) n FROM run_notifications WHERE user_id = ? AND tenant_id = ? AND read_at IS NULL").get(userId, tenantId) as { n: number }).n;
}

export function markRunNotificationsRead(db: DB, userId: number, tenantId: number, ids: number[] | "all", now = Date.now()): number {
  if (ids === "all") {
    return Number(db.prepare("UPDATE run_notifications SET read_at = ? WHERE user_id = ? AND tenant_id = ? AND read_at IS NULL").run(now, userId, tenantId).changes);
  }
  const want = ids.filter((n) => Number.isInteger(n));
  if (!want.length) return 0;
  const marks = want.map(() => "?").join(",");
  return Number(db.prepare(`UPDATE run_notifications SET read_at = ? WHERE user_id = ? AND tenant_id = ? AND read_at IS NULL AND id IN (${marks})`)
    .run(now, userId, tenantId, ...want).changes);
}
