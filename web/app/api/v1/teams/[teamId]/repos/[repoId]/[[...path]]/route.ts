// Team API ingress. Bearer key only (session cookies are ignored here); see lib/team-api/service.ts.
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { handle } from "@/lib/team-api/service";
import { getDb, runDeps } from "@/lib/workflows/server";

type Ctx = { params: Promise<{ teamId: string; repoId: string; path?: string[] }> };
const MAX_BODY = 512 * 1024;

async function serve(req: Request, ctx: Ctx) {
  const { teamId, repoId, path } = await ctx.params;
  let body: unknown = undefined;
  if (req.method !== "GET" && req.method !== "DELETE") {
    const text = await req.text().catch(() => "");
    if (text.length > MAX_BODY) return NextResponse.json({ error: "body too large" }, { status: 413 });
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  }
  const r = handle(getDb(), { method: req.method, teamId, repoId, path: path ?? [], auth: req.headers.get("authorization"), ip: clientIp(req), body }, (t, a) => runDeps(t, a));
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store", ...(r.headers ?? {}) } });
}

export const GET = serve, POST = serve, PUT = serve, DELETE = serve, PATCH = serve;
