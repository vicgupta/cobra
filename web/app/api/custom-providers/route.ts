import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { getDb, secretValue } from "@/lib/workflows/server";
import { addApi, listApi } from "@/lib/custom-providers-api";

/** The caller's team's custom OpenAI-compatible providers. Keys are never returned. */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = listApi(getDb(), g.user, secretValue("COBRA_SECRET_KEY"));
  return NextResponse.json(r.body, { status: r.status });
}

/** Body: { id, name, baseUrl, models: string[] | "a, b", apiKey? }. Team members only (the caller's team). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = await addApi(getDb(), g.user, await req.json().catch(() => null), secretValue("COBRA_SECRET_KEY"));
  return NextResponse.json(r.body, { status: r.status });
}
