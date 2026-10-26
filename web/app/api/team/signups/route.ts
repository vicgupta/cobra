import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { setSignupsAllowed } from "@/lib/registration";
import { regError } from "@/lib/registration-route";
import { getDb } from "@/lib/workflows/server";

/** { allow: boolean } — system admins only (audited). */
export async function PUT(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const b = (await req.json().catch(() => null)) as { allow?: unknown } | null;
  try {
    return NextResponse.json(setSignupsAllowed(getDb(), g.user, b?.allow));
  } catch (e) { return regError(e); }
}
