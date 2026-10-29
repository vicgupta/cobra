import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { feedback } from "@/lib/lessons/service";

/** { text } — any member of the lesson's team. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = feedback(getDb(), actor(g.user), (await params).id, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
