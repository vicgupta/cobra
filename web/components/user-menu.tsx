import "server-only";
import { currentUser } from "@/lib/auth/server";
import { LogoutButton } from "./logout-button";
import { isSystemAdmin } from "@/lib/admin/gate";
import { displayName } from "@/lib/display-name";

export async function UserMenu() {
  const u = await currentUser();
  if (!u) return null;
  const admin = isSystemAdmin(u.email);
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-right leading-tight lg:block">
        <span data-user-name className="block max-w-[12rem] truncate text-fg-soft">{displayName(u)}</span>
        <span className="block text-xs text-subtle">{u.tenantName}{admin ? " · System admin" : ""}</span>
      </span>
      <LogoutButton />
    </div>
  );
}
