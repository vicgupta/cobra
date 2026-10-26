import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { setAuthMode } from "@/lib/provider-credentials";
import { getDb } from "@/lib/workflows/server";

/** Settings > Providers: choose the auth method { mode: "auto" | "api_key" | "subscription" }. System admins only. */
export async function PUT(req: Request, ctx: { params: Promise<{ engine: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { mode?: unknown } | null;
  try {
    return NextResponse.json({ auth: setAuthMode(getDb(), g.user, (await ctx.params).engine, b?.mode) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
