import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { getDb, secretValue } from "@/lib/workflows/server";
import { testSavedApi } from "@/lib/custom-providers-api";

/** Test a saved provider with its stored key. Team members only; the result is not saved. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = await testSavedApi(getDb(), g.user, (await ctx.params).id, secretValue("COBRA_SECRET_KEY"));
  return NextResponse.json(r.body, { status: r.status });
}
