import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { setProviderSecret } from "@/lib/providers";
import { getDb, secretValue } from "@/lib/workflows/server";

/** Settings > Providers secret (Cursor: CURSOR_API_KEY). { value: string } sets, { value: null } clears.
 *  System admins only. The response carries set / not set, never the value. */
export async function PUT(req: Request, ctx: { params: Promise<{ engine: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { value?: unknown } | null;
  try {
    if (!b || !("value" in b)) throw new CollabError(400, "send value (a string, or null to clear)");
    return NextResponse.json({ secret: setProviderSecret(getDb(), g.user, (await ctx.params).engine, b.value, secretValue("COBRA_SECRET_KEY")) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
