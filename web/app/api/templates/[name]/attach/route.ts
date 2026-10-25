import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb, githubStore } from "@/lib/workflows/server";
import { attachTemplate } from "@/lib/workflows/service";

/** Creates a team workflow instance from a template, attached to one of the team's repos. */
export async function POST(req: Request, ctx: { params: Promise<{ name: string }> }) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { repo?: unknown; name?: unknown } | null;
  const r = await attachTemplate(getDb(), actor(g.user), { ...b, template: (await ctx.params).name }, { github: githubStore(g.user.tenantId) });
  return NextResponse.json(r.body, { status: r.status });
}
