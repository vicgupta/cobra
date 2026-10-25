import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { agentIssue } from "@/lib/collab";

/** Agent-written issue: { engine | agent, prompt, title?, mode }. Returns the run id; the issue is opened when the run succeeds. */
export const POST = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, async ({ db, gh, u, repo, body, deps }) => ({ runId: agentIssue(db, gh, u, repo, body, deps()).runId }), 201);
