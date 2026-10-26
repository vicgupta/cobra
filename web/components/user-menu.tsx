import "server-only";
import { currentUser } from "@/lib/auth/server";
import { LogoutButton } from "./logout-button";
import { isSystemAdmin } from "@/lib/admin/gate";

export async function UserMenu() {
  const u = await currentUser();
  if (!u) return null;
  const admin = isSystemAdmin(u.email);
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-right leading-tight sm:block">
        <span className="block text-fg-soft">{u.email}</span>
        <span className="block text-xs text-subtle">{u.tenantName}{admin ? " · System admin" : ""}</span>
      </span>
      <a href="/account/sessions" className="rounded-md border border-border-strong px-2.5 py-1 text-xs text-fg-soft hover:bg-surface">Sessions</a>
      <LogoutButton />
    </div>
  );
}
