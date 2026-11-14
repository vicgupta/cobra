import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { activateLibraryPack, LIBRARY_PACKS, LibraryError } from "@/lib/automation-library";
import { actor, getDb } from "@/lib/workflows/server";

/** Catalog of one-click engineering packs (no secrets). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  return NextResponse.json({ packs: LIBRARY_PACKS });
}

/** Confirm-and-activate: creates the pack's skill and task from the (possibly edited) form. */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { return NextResponse.json(activateLibraryPack(getDb(), actor(g.user), await req.json().catch(() => null)), { status: 201 }); }
  catch (e) { if (e instanceof LibraryError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
}
