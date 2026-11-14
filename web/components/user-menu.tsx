import "server-only";
import { currentUser } from "@/lib/auth/server";
import { LogoutButton } from "./logout-button";
import { RunNotificationBell } from "./run-notification-bell";
import { getDb } from "@/lib/db";
import { listRunNotifications, unreadRunNotificationCount } from "@/lib/run-notifications";
import { isSystemAdmin } from "@/lib/admin/gate";
import { RoleIcon } from "./role-icon";

export async function UserMenu() {
  const u = await currentUser();
  if (!u) return null;
  const admin = isSystemAdmin(u.email);
  const db = getDb();
  const notifications = listRunNotifications(db, u.id, u.tenantId);
  const unread = unreadRunNotificationCount(db, u.id, u.tenantId);
  return (
    <div className="flex items-center gap-3 text-sm">
      <RunNotificationBell initial={{ unread, notifications }} />
      {/* No name, email or team name in the header (saves space); role is an icon only (tooltip on hover) plus the admin badge. */}
      {admin && <span data-user-admin className="hidden max-w-[14rem] truncate text-right text-xs leading-tight text-subtle lg:block">System admin</span>}
      {(u.role === "team_lead" || u.role === "member") && <RoleIcon role={u.role} />}
      <LogoutButton />
    </div>
  );
}
