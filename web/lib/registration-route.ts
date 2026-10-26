import "server-only";
import { NextResponse } from "next/server";
import { CollabError } from "./collab";

export function regError(e: unknown) {
  if (e instanceof CollabError) return NextResponse.json({ error: e.message }, { status: e.status });
  throw e;
}
