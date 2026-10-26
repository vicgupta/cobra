import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { setProviderDefaults } from "@/lib/providers";
import { getDb } from "@/lib/workflows/server";

/** Settings > Providers: { model?: id | "default" | null, effort?: "low"|"medium"|"high"|"default"|null }. System admins only (lib/providers.ts). */
export async function PUT(req: Request, ctx: { params: Promise<{ engine: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { model?: unknown; effort?: unknown } | null;
  try {
    return NextResponse.json({ defaults: setProviderDefaults(getDb(), g.user, (await ctx.params).engine, b) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
