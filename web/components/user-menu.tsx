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
      {/* Job 7d: no name or email in the header, only the team (and admin badge). */}
      <span data-user-team className="hidden max-w-[14rem] truncate text-right text-xs leading-tight text-subtle lg:block">{u.tenantName}{admin ? " · System admin" : ""}</span>
      <LogoutButton />
    </div>
  );
}
