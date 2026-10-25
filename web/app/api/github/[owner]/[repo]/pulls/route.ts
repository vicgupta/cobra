import { collabRoute, type RepoParams } from "@/lib/collab-route";
import { repoGate } from "@/lib/collab";

export const GET = (req: Request, ctx: RepoParams) => collabRoute(req, ctx, async ({ db, gh, u, repo }) => ({ pulls: await gh.listPulls(repoGate(db, u, repo)) }));
