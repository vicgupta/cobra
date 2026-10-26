import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor } from "@/lib/workflows/server";
import { validatePlan } from "@/lib/skills/plan";
import { derivePlan } from "@/lib/skills/store";

/** Live validation for the editor: plan errors (nothing is stored). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  actor(g.user);
  const b = (await req.json().catch(() => null)) as { plan?: unknown; body?: unknown; description?: unknown } | null;
  const empty = b?.plan === undefined || b.plan === null || (typeof b.plan === "string" && !b.plan.trim());
  const v = validatePlan(empty ? derivePlan() : b!.plan);
  if (!v.ok) return NextResponse.json({ ok: false, errors: v.errors });
  return NextResponse.json({ ok: true, derived: empty, steps: v.plan.steps.length });
}
