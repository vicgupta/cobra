import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { createPrFromIssue } from "@/lib/collab";

/** "Create PR": { engine | agent, instructions? }. Real agent run on cobra/<run-id>, then a PR that closes the issue. */
export const POST = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, async ({ db, gh, u, repo, number, body, deps }) => ({ runId: (await createPrFromIssue(db, gh, u, repo, number, body, deps())).runId }), 201);
