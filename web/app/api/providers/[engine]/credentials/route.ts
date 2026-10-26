import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError, isSystemAdmin } from "@/lib/collab";
import { setCredential } from "@/lib/provider-credentials";
import { getDb, secretValue } from "@/lib/workflows/server";
import { OPENROUTER, setOpenRouterKey } from "@/lib/openrouter";

/** Settings > Providers: set / replace ({ name, value }) or delete ({ name, value: null }) one credential slot.
 *  System admins only. The response is masked status (set, last 4, who, when), never the value.
 *  OpenRouter (on hold) goes through its existing set/clear path unchanged. */
export async function PUT(req: Request, ctx: { params: Promise<{ engine: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { name?: unknown; value?: unknown } | null;
  try {
    if (!b || !("value" in b)) throw new CollabError(400, "send name and value (a string, or null to delete)");
    const engine = (await ctx.params).engine, db = getDb(), key = secretValue("COBRA_SECRET_KEY");
    if (engine === OPENROUTER.id) {
      if (!isSystemAdmin(g.user)) throw new CollabError(403, "only system admins can change provider credentials");
      if (b.name !== OPENROUTER.name) throw new CollabError(400, `OpenRouter has one credential: ${OPENROUTER.name}`);
      const s = setOpenRouterKey(db, g.user, b.value, key, Date.now(), secretValue(OPENROUTER.envFallback));
      return NextResponse.json({ credential: { name: OPENROUTER.name, set: s.set, source: s.source, setAt: s.setAt, setBy: s.setBy } });
    }
    return NextResponse.json({ credential: setCredential(db, g.user, engine, b.name, b.value, key, secretValue) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
