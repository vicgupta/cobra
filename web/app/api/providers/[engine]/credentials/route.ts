import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { setCredential } from "@/lib/provider-credentials";
import { getDb, secretValue } from "@/lib/workflows/server";

/** Settings > Providers: set / replace ({ name, value }) or delete ({ name, value: null }) one credential slot.
 *  Team members only, for their own team. The response is masked status (set, last 4, who, when), never the value.
 *  MVP build: Claude Code and Codex only. */
export async function PUT(req: Request, ctx: { params: Promise<{ engine: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { name?: unknown; value?: unknown } | null;
  try {
    if (!b || !("value" in b)) throw new CollabError(400, "send name and value (a string, or null to delete)");
    const engine = (await ctx.params).engine, db = getDb(), key = secretValue("COBRA_SECRET_KEY");
    return NextResponse.json({ credential: setCredential(db, g.user, engine, b.name, b.value, key, secretValue) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
