import { NextResponse } from "next/server";
import type { LimitState } from "./rate-limit";

export function tooMany(s: LimitState, error = "Too many attempts. Try again in 15 minutes.") {
  return NextResponse.json({ error }, { status: 429, headers: { "Retry-After": String(s.retryAfterSec) } });
}
