import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { listAudit, repoGate } from "@/lib/collab";

export const GET = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, async ({ db, gh, u, repo, number }) => {
  repo = repoGate(db, u, repo);
  const n = Number(number);
  const [issue, comments] = await Promise.all([gh.getIssue(repo, n), gh.issueComments(repo, n)]);
  return { issue, comments, audit: listAudit(db, u.tenantId, repo, n) };
});
