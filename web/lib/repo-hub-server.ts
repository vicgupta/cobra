import "server-only";
import { branchRepoGate, visibleBranches } from "./repo-hub";
import { getDb, githubClient } from "./workflows/server";

/** Non-Cobra branches of one allowed repo (gate first, then GitHub, then drop cobra/*). */
export async function repoBranches(u: { role: string; tenantId: number }, repo: string) {
  const r = branchRepoGate(getDb(), u, repo);
  const [info, bs] = await Promise.all([githubClient(u.tenantId).repoInfo(r), githubClient(u.tenantId).listBranches(r)]);
  return { repo: r, defaultBranch: info.default_branch, branches: visibleBranches(bs).map((b) => ({ name: b.name, protected: b.protected, sha: b.commit.sha })) };
}
