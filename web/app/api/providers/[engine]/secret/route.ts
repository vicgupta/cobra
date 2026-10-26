import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { setProviderSecret } from "@/lib/providers";
import { getDb, secretValue } from "@/lib/workflows/server";
import { OPENROUTER, setOpenRouterKey } from "@/lib/openrouter";

/** Settings > Providers secret (Cursor: CURSOR_API_KEY; openrouter: the global OPENROUTER_API_KEY). { value: string } sets, { value: null } clears.
 *  Team members for their own team (OpenRouter: system admins). The response carries set / not set, never the value. */
export async function PUT(req: Request, ctx: { params: Promise<{ engine: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { value?: unknown } | null;
  try {
    if (!b || !("value" in b)) throw new CollabError(400, "send value (a string, or null to clear)");
    const engine = (await ctx.params).engine;
    // OpenRouter: one global key for all teams; system admins only; response is set / not set only.
    if (engine === OPENROUTER.id) return NextResponse.json({ secret: setOpenRouterKey(getDb(), g.user, b.value, secretValue("COBRA_SECRET_KEY"), Date.now(), secretValue(OPENROUTER.envFallback)) });
    return NextResponse.json({ secret: setProviderSecret(getDb(), g.user, (await ctx.params).engine, b.value, secretValue("COBRA_SECRET_KEY")) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
