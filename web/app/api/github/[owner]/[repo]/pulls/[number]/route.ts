import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { canMerge, listAudit, repoGate } from "@/lib/collab";

export const GET = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, async ({ db, gh, u, repo, number }) => {
  repo = repoGate(db, u, repo);
  const n = Number(number);
  const [pull, reviews, reviewComments, comments] = await Promise.all([gh.getPull(repo, n), gh.pullReviews(repo, n), gh.reviewComments(repo, n), gh.issueComments(repo, n)]);
  return { pull, reviews, reviewComments, comments, canMerge: canMerge(db, u), audit: listAudit(db, u.tenantId, repo, n) };
});
