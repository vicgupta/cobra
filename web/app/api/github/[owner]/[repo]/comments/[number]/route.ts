import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { addComment } from "@/lib/collab";

/** Comment on an issue or PR: { body } (whole team). */
export const POST = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, ({ db, gh, u, repo, number, body }) => addComment(db, gh, u, repo, number, body), 201);
