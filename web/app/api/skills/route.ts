import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { create, list } from "@/lib/skills/service";

export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = list(getDb(), actor(g.user));
  return NextResponse.json(r.body, { status: r.status });
}

/** Create a skill in your team (any member or team lead). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = create(getDb(), actor(g.user), await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
