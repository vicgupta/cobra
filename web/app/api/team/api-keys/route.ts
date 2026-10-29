import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { canManageKeys, createKey, KeyError, listKeys } from "@/lib/team-api/keys";

/** The team's API keys (prefix, repo, last used; never the key). Any member can view; only leads manage. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const db = getDb(), u = actor(g.user);
  return NextResponse.json({ keys: listKeys(db, u.tenantId), canManage: canManageKeys(db, u) });
}

/** Creates a key bound to one team repo. The plaintext is in this response only. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try {
    const r = createKey(getDb(), actor(g.user), await req.json().catch(() => null));
    return NextResponse.json({ key: r.key, plaintext: r.plaintext }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof KeyError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
