// Any other /api/v1 path: a JSON 404 (instead of the HTML not-found page) that points at the real base path.
import { NextResponse } from "next/server";
const notFound = () => NextResponse.json({ error: "not found; the Team API base path is /api/v1/teams/{teamId}/repos/{repoId} (see /docs/api)" }, { status: 404, headers: { "Cache-Control": "no-store" } });
export const GET = notFound, POST = notFound, PUT = notFound, DELETE = notFound, PATCH = notFound;
