import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { createIssue, repoGate } from "@/lib/collab";

/** Open issues of a team repo (any team member). */
export const GET = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, async ({ db, gh, u, repo }) => ({ issues: await gh.listIssues(repoGate(db, u, repo)) }));
/** Manual issue: { title, body } (any team member, no approval). */
export const POST = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, ({ db, gh, u, repo, body }) => createIssue(db, gh, u, repo, body), 201);
