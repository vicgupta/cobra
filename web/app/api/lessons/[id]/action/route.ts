import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { act } from "@/lib/lessons/service";

/** { action: approve | reject | retire | reopen, reason? } (reviewers only). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = act(getDb(), actor(g.user), (await params).id, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
