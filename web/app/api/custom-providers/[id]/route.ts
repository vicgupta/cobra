import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { getDb, secretValue } from "@/lib/workflows/server";
import { deleteApi, updateApi } from "@/lib/custom-providers-api";

/** Edit: { name?, baseUrl?, models?, apiKey?: string (replace) | null (delete) }. Team members only. */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = await updateApi(getDb(), g.user, (await ctx.params).id, await req.json().catch(() => null), secretValue("COBRA_SECRET_KEY"));
  return NextResponse.json(r.body, { status: r.status });
}

/** Removes the provider and its stored key; 409 while a team agent uses one of its models. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = await deleteApi(getDb(), g.user, (await ctx.params).id);
  return NextResponse.json(r.body, { status: r.status });
}
