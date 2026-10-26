// Minimal GitHub REST client for issues and pull requests. The token comes from the
// server env file at call time and only ever goes into the Authorization header.
export class GitHubApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export type GhUser = { login: string } | null;
export type GhIssue = { number: number; title: string; body: string | null; state: string; html_url: string; user: GhUser; created_at: string; comments: number; labels?: Array<{ name: string }>; pull_request?: unknown };
export type GhComment = { id: number; body: string | null; user: GhUser; created_at: string; html_url: string; path?: string; line?: number | null };
export type GhReview = { id: number; state: string; body: string | null; user: GhUser; submitted_at: string | null };
export type GhPull = { number: number; title: string; body: string | null; state: string; html_url: string; user: GhUser; created_at: string; merged?: boolean; merged_at: string | null; mergeable?: boolean | null; mergeable_state?: string; draft?: boolean; head: { ref: string; sha: string }; base: { ref: string } };

export type GitHub = ReturnType<typeof githubApi>;

/** A token, or a resolver per repo ("owner/name"): the repo's PAT when set, else GITHUB_TOKEN. */
export type TokenSource = string | undefined | ((repo: string) => string | undefined);
const repoOfPath = (p: string) => { const m = /^\/repos\/([^/?]+)\/([^/?]+)/.exec(p); return m ? `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` : ""; };

export function githubApi(source: TokenSource, fetchImpl: typeof fetch = fetch) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const token = typeof source === "function" ? source(repoOfPath(path)) : source;
    if (!token) throw new GitHubApiError(503, "GITHUB_TOKEN is not set in the server env file");
    const r = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cobra", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!r.ok) {
      const m = json && typeof json.message === "string" ? json.message : `HTTP ${r.status}`;
      throw new GitHubApiError(r.status, `GitHub ${method} ${path.split("?")[0]}: ${m}`);
    }
    return json as T;
  };
  const R = (repo: string) => `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
  return {
    repoInfo: (repo: string) => call<{ default_branch: string; open_issues_count?: number; permissions?: Record<string, boolean>; allow_merge_commit?: boolean }>("GET", R(repo)),
    listIssues: async (repo: string, state = "open") => (await call<GhIssue[]>("GET", `${R(repo)}/issues?state=${state}&per_page=50`)).filter((i) => !i.pull_request),
    getIssue: (repo: string, n: number) => call<GhIssue>("GET", `${R(repo)}/issues/${n}`),
    createIssue: (repo: string, title: string, body: string) => call<GhIssue>("POST", `${R(repo)}/issues`, { title, body }),
    issueComments: (repo: string, n: number) => call<GhComment[]>("GET", `${R(repo)}/issues/${n}/comments?per_page=100`),
    comment: (repo: string, n: number, body: string) => call<GhComment>("POST", `${R(repo)}/issues/${n}/comments`, { body }),
    listPulls: (repo: string, state = "open") => call<GhPull[]>("GET", `${R(repo)}/pulls?state=${state}&per_page=50`),
    listBranches: (repo: string) => call<Array<{ name: string; protected: boolean; commit: { sha: string } }>>("GET", `${R(repo)}/branches?per_page=100`),
    getPull: (repo: string, n: number) => call<GhPull>("GET", `${R(repo)}/pulls/${n}`),
    pullReviews: (repo: string, n: number) => call<GhReview[]>("GET", `${R(repo)}/pulls/${n}/reviews?per_page=100`),
    reviewComments: (repo: string, n: number) => call<GhComment[]>("GET", `${R(repo)}/pulls/${n}/comments?per_page=100`),
    createPull: (repo: string, p: { title: string; body: string; head: string; base: string }) => call<GhPull>("POST", `${R(repo)}/pulls`, p),
    /** Plain merge commit, pinned to the head sha we showed (never forced). */
    merge: (repo: string, n: number, sha: string) => call<{ merged: boolean; sha: string; message: string }>("PUT", `${R(repo)}/pulls/${n}/merge`, { merge_method: "merge", sha }),
  };
}
