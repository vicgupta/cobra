import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError } from "@/lib/collab";
import { deleteCustomProvider, updateCustomProvider } from "@/lib/provider-credentials";
import { getDb, secretValue } from "@/lib/workflows/server";

/** Edit: { name?, baseUrl?, models?, apiKey?: string (replace) | null (delete) }. Team members only (the caller's team). */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    if (!b) throw new CollabError(400, "send JSON");
    return NextResponse.json({ provider: updateCustomProvider(getDb(), g.user, (await ctx.params).id, b, secretValue("COBRA_SECRET_KEY")) });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** Deletes the provider and its stored API key. Agents still naming its models fail at run time with a clear error. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try {
    deleteCustomProvider(getDb(), g.user, (await ctx.params).id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
