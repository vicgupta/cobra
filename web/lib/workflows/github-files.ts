// Minimal GitHub contents API client for workflows stored in a repo (storage: github).
// The token comes from the server env file at call time; it is never stored or logged.
export type GitHubFile = { content: string; sha: string };
export type GitHubFiles = {
  get(repo: string, path: string, branch?: string): Promise<GitHubFile | null>;
  put(repo: string, path: string, content: string, opts: { sha?: string; branch?: string; message: string }): Promise<{ sha: string }>;
};

export class GitHubStorageError extends Error {}

export function checkLocation(repo: string, path: string): string[] {
  const errs: string[] = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) errs.push("github repo must look like owner/name");
  if (!/^[\w./-]+\.ya?ml$/.test(path) || path.split("/").includes("..") || path.startsWith("/")) errs.push("github path must be a relative .yaml/.yml path");
  // Team registration + the optional COBRA_GITHUB_ALLOWED_REPOS ceiling are checked by checkTeamRepo (lib/repos.ts).
  return errs;
}

export function githubFiles(token: string | undefined, fetchImpl: typeof fetch = fetch): GitHubFiles {
  const call = async (url: string, init: RequestInit = {}) => {
    if (!token) throw new GitHubStorageError("GITHUB_TOKEN is not set in the server env file, so GitHub storage is unavailable");
    return fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" } });
  };
  const url = (repo: string, path: string) => `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async get(repo, path, branch) {
      const r = await call(url(repo, path) + (branch ? `?ref=${encodeURIComponent(branch)}` : ""));
      if (r.status === 404) return null;
      if (!r.ok) throw new GitHubStorageError(`GitHub read failed (HTTP ${r.status})`);
      const j = (await r.json()) as { content?: string; sha: string };
      return { content: Buffer.from(j.content ?? "", "base64").toString("utf8"), sha: j.sha };
    },
    async put(repo, path, content, { sha, branch, message }) {
      const r = await call(url(repo, path), { method: "PUT", body: JSON.stringify({ message, content: Buffer.from(content).toString("base64"), sha, branch }) });
      if (r.status === 409 || r.status === 422) throw new GitHubStorageError("the file changed on GitHub since it was last synced; sync it first");
      if (!r.ok) throw new GitHubStorageError(`GitHub write failed (HTTP ${r.status})`);
      const j = (await r.json()) as { content: { sha: string } };
      return { sha: j.content.sha };
    },
  };
}
