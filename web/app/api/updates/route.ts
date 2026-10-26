import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { CollabError, isSystemAdmin } from "@/lib/collab";
import { getDb } from "@/lib/db";
import { getUpdateRun, listUpdateRuns, setUpdatesEnabled, startManualRun, updateSettings } from "@/lib/tool-updates";
import { nodeOps } from "@/lib/tool-updates-node";

const err = (e: unknown) => { if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; };

/** Settings > Updates (system admins only; 404 for everyone else). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  if (!isSystemAdmin(g.user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const db = getDb(), id = Number(new URL(req.url).searchParams.get("run")) || undefined;
  return NextResponse.json({ settings: updateSettings(db), run: getUpdateRun(db, id), runs: listUpdateRuns(db) });
}

/** { enabled: boolean } toggles the daily 4 AM update; { action: "run" } starts one now (202). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  if (!isSystemAdmin(g.user)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = (await req.json().catch(() => null)) as { enabled?: unknown; action?: unknown } | null;
  try {
    if (b?.action === "run") return NextResponse.json({ runId: startManualRun(getDb(), g.user, nodeOps) }, { status: 202 });
    if (b && "enabled" in b) { setUpdatesEnabled(getDb(), g.user, b.enabled); return NextResponse.json({ settings: updateSettings(getDb()) }); }
    throw new CollabError(400, "send { enabled: boolean } or { action: \"run\" }");
  } catch (e) { return err(e); }
}
