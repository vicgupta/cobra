import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { putRule, rules } from "@/lib/skills/service";

/** System admins only (404 for everyone else). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = rules(getDb(), actor(g.user));
  return NextResponse.json(r.body, { status: r.status });
}
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = putRule(getDb(), actor(g.user), await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
