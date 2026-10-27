import { NextResponse } from "next/server";
import { apiGuard } from "@/lib/auth/server";
import { TaskError, canEditTask, createTask, listTasks } from "@/lib/tasks";
import { actor, getDb } from "@/lib/workflows/server";

/** The team's tasks (other teams never see them). */
export async function GET(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  const u = actor(g.user), db = getDb();
  return NextResponse.json({ tasks: listTasks(db, u.tenantId).map((t) => ({ ...t, canEdit: canEditTask(u, t, db) })) });
}

/** Any team member may create a task (disabled unless enabled is sent with a cron). */
export async function POST(req: Request) {
  const g = await apiGuard(req);
  if (g.error) return g.error;
  try { return NextResponse.json(createTask(getDb(), actor(g.user), await req.json().catch(() => null)), { status: 201 }); }
  catch (e) { if (e instanceof TaskError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
}
