import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { detail, edit } from "@/lib/lessons/service";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = detail(getDb(), actor(g.user), (await params).id);
  return NextResponse.json(r.body, { status: r.status });
}

/** Edit any field (reviewers only). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = edit(getDb(), actor(g.user), (await params).id, await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
