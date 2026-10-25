import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { mergePull } from "@/lib/collab";

/** Merge (designated lead or system admin only; enforced in mergePull). */
export const POST = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, ({ db, gh, u, repo, number }) => mergePull(db, gh, u, repo, number));
