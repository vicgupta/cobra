import "server-only";
import { currentUser } from "@/lib/auth/server";
import { LogoutButton } from "./logout-button";
import { isSystemAdmin } from "@/lib/admin/gate";

export async function UserMenu() {
  const u = await currentUser();
  if (!u) return null;
  const admin = isSystemAdmin(u.email);
  return (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span className="hidden text-right leading-tight sm:block">
        <span className="block text-zinc-200">{u.email}</span>
        <span className="block text-xs text-zinc-500">{admin ? "System admin" : u.tenantName}</span>
      </span>
      {!admin && <a href="/account/sessions" className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-900">Sessions</a>}
      <LogoutButton />
    </div>
  );
}
