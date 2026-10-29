import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { create, list } from "@/lib/lessons/service";

/** Your team's lessons (?status=queue|history|pending|approved|...&repo=owner/name). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const q = new URL(req.url).searchParams;
  const r = list(getDb(), actor(g.user), q.get("status") ?? undefined, q.get("repo") ?? undefined);
  return NextResponse.json(r.body, { status: r.status });
}

/** Add a lesson by hand (team leads / designated lead / admins of the team). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const r = create(getDb(), actor(g.user), await req.json().catch(() => null));
  return NextResponse.json(r.body, { status: r.status });
}
