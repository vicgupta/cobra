import "server-only";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/server";
import { canUseSharedConfig, type SessionUser } from "@/lib/auth/sessions";

/** Server-side session check for pages. With `shared`, only default-tenant admins see children. */
export async function AuthGate({ children, shared }: { children: ReactNode | ((u: SessionUser) => ReactNode); shared?: boolean }) {
  const user = await requireUser();
  if (shared && !canUseSharedConfig(user)) return <ComingSoon />;
  return <>{typeof children === "function" ? children(user) : children}</>;
}

export function ComingSoon() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-700 px-6 py-10 text-center">
      <p className="font-medium">Coming soon for your workspace</p>
      <p className="mt-1 text-sm text-zinc-400">Agent credentials and runs aren&apos;t available for new workspaces yet.</p>
    </div>
  );
}
