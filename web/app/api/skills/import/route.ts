import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, githubTokenFor } from "@/lib/workflows/server";
import { importSkill } from "@/lib/skills/import";

/** Import from URL: fetch + parse + validate a SKILL.md for the new-skill form. Signed-in team members (same as create). Saves nothing. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = actor(g.user);
  const b = (await req.json().catch(() => null)) as { url?: unknown } | null;
  const r = await importSkill(getDb(), u.tenantId, b?.url, { githubToken: githubTokenFor(u.tenantId) });
  return NextResponse.json(r.body, { status: r.status });
}
