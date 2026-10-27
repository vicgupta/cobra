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
      {/* No name, email or team name in the header (saves space); only the admin badge. */}
      {admin && <span data-user-admin className="hidden max-w-[14rem] truncate text-right text-xs leading-tight text-subtle lg:block">System admin</span>}
      <LogoutButton />
    </div>
  );
}
