import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { testDraftApi } from "@/lib/custom-providers-api";

/** Test unsaved settings from the add form: { baseUrl, apiKey, models }. Team members only; nothing is saved. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = await testDraftApi(g.user, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
