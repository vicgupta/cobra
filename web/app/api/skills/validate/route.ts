import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { actor, getDb } from "@/lib/workflows/server";
import { checkSkill } from "@/lib/skills/store";

/** Live validation for the editor: exactly the checks a save runs (nothing is stored). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = actor(g.user);
  const b = (await req.json().catch(() => null)) as { name?: unknown; body?: unknown; description?: unknown; kind?: unknown } | null;
  return NextResponse.json(checkSkill(getDb(), u.tenantId, { name: b?.name, body: b?.body, description: b?.description, kind: b?.kind === "master" ? "master" : undefined }));
}
