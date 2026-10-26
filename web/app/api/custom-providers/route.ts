import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { addCustomProvider, canManageProviders, customProviderViews } from "@/lib/provider-credentials";
import { getDb, secretValue } from "@/lib/workflows/server";

/** The caller's team's custom OpenAI-compatible providers (OpenCode engine). Team members get masked key status;
 *  system admins (read-only) get names/models and set / not set only. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const m = canManageProviders(g.user);
  return NextResponse.json({ providers: customProviderViews(getDb(), g.user.tenantId, secretValue("COBRA_SECRET_KEY"), m).map((p) => m ? p : { id: p.id, name: p.name, models: p.models, key: { set: p.key.set } }) });
}

/** Body: { id, name, baseUrl, models: string[] | "a, b", apiKey? }. Team members only (the caller's team). */
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
