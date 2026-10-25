import "server-only";
import { currentUser } from "@/lib/auth/server";
import { LogoutButton } from "./logout-button";

export async function UserMenu() {
  const u = await currentUser();
  if (!u) return null;
  return (
    <div className="ml-auto flex items-center gap-3 text-sm">
      <span className="hidden text-right leading-tight sm:block">
        <span className="block text-zinc-200">{u.username ?? u.email}</span>
        <span className="block text-xs text-zinc-500">{u.tenantName}</span>
      </span>
      <LogoutButton />
    </div>
  );
}
