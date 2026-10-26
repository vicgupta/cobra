import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError, isSystemAdmin } from "@/lib/collab";
import { addCustomProvider, customProviderViews } from "@/lib/provider-credentials";
import { getDb, secretValue } from "@/lib/workflows/server";

/** Custom OpenAI-compatible providers (run on the OpenCode engine). Admins get masked key status; others names/models only. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const admin = isSystemAdmin(g.user);
  return NextResponse.json({ providers: customProviderViews(getDb(), secretValue("COBRA_SECRET_KEY"), admin).map((p) => admin ? p : { id: p.id, name: p.name, models: p.models, key: { set: p.key.set } }) });
}

/** Body: { id, name, baseUrl, models: string[] | "a, b", apiKey? }. System admins only. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    if (!b) throw new CollabError(400, "send JSON");
    const p = addCustomProvider(getDb(), g.user, b, secretValue("COBRA_SECRET_KEY"));
    return NextResponse.json({ provider: p }, { status: 201 });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
