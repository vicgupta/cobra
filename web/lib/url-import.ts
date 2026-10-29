// "Import from URL" for skills (Claude SKILL.md) and agents (Claude Code subagent .md): server-side fetch.
// Accepted forms: github.com/<o>/<r>/tree/<ref>/<path> (folder), github.com/<o>/<r>/blob/<ref>/<path> (file),
// raw.githubusercontent.com/<o>/<r>/<ref>/<path> (also refs/heads/<branch>/...), gist.github.com/<user>/<id>,
// or any other https URL serving the file. https only; every host (each redirect hop included) must be public
// (lib/safe-fetch.ts); redirects only within the same host, 3 hops at most; 10 s timeout; 256 KB cap; text only.
// GitHub requests carry the team's token for that repo (Settings > Repos PAT, else the server GITHUB_TOKEN) as a
// header only, and only to api.github.com / raw.githubusercontent.com. The token never leaves the server: errors
// are fixed messages and nothing derived from it is returned.
import { parse as parseYaml } from "yaml";
import { BlockedHostError, guardPublicHost, type GuardDeps } from "./safe-fetch";

export const IMPORT_MAX_BYTES = 256 * 1024;
export const IMPORT_TIMEOUT_MS = 10_000;
const MAX_HOPS = 3;
const MAX_LIST_DIRS = 20;

export class ImportError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export type Target =
  | { kind: "github-tree"; owner: string; repo: string; ref: string; path: string }
  | { kind: "github-file"; owner: string; repo: string; ref: string; path: string }
  | { kind: "gist"; id: string; file?: string }
  | { kind: "url"; url: string };

const seg = (s: string) => decodeURIComponent(s);
const okName = (s: string) => /^[A-Za-z0-9_.-]{1,100}$/.test(s);

/** Parses and classifies an import URL. Throws ImportError(400) for non-https or malformed URLs. */
export function normalizeImportUrl(raw: unknown): Target {
  if (typeof raw !== "string" || !raw.trim()) throw new ImportError(400, "Enter a URL to import from");
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ImportError(400, "That doesn't look like a URL"); }
  if (u.protocol !== "https:") throw new ImportError(400, "Only https:// URLs can be imported");
  if (u.username || u.password) throw new ImportError(400, "URLs with a user name or password can't be imported");
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean).map(seg);
  if (host === "github.com" || host === "www.github.com") {
    const [owner, repo, mode, ...rest] = parts;
    if (!owner || !repo || !okName(owner) || !okName(repo)) throw new ImportError(400, "GitHub URL must look like github.com/<owner>/<repo>/tree/<branch>/<folder> or /blob/<branch>/<file>");
    if ((mode === "tree" || mode === "blob") && rest.length >= 1) {
      const { ref, path } = splitRef(rest);
      if (mode === "blob" && !path) throw new ImportError(400, "GitHub file URL has no file path");
      return { kind: mode === "tree" ? "github-tree" : "github-file", owner, repo: repo.replace(/\.git$/, ""), ref, path };
    }
    if (!mode) return { kind: "github-tree", owner, repo: repo.replace(/\.git$/, ""), ref: "", path: "" };
    throw new ImportError(400, "GitHub URL must point to a folder (/tree/...) or a file (/blob/...)");
  }
  if (host === "raw.githubusercontent.com") {
    const [owner, repo, ...rest] = parts;
    if (!owner || !repo || rest.length < 2) throw new ImportError(400, "raw.githubusercontent.com URL must look like /<owner>/<repo>/<branch>/<path>");
    const { ref, path } = splitRef(rest);
    if (!path) throw new ImportError(400, "raw.githubusercontent.com URL has no file path");
    return { kind: "github-file", owner, repo, ref, path };
  }
  if (host === "gist.github.com" || host === "gist.githubusercontent.com") {
    const id = parts.find((p) => /^[0-9a-f]{20,40}$/i.test(p));
    if (!id) throw new ImportError(400, "Gist URL must look like gist.github.com/<user>/<id>");
    const file = host === "gist.githubusercontent.com" ? parts.at(-1) : (u.hash.match(/^#file-(.+)$/)?.[1]);
    return { kind: "gist", id, ...(host === "gist.githubusercontent.com" && file && file !== id ? { file } : {}) };
  }
  u.hash = "";
  return { kind: "url", url: u.toString() };
}

/** refs/heads/<b>/... and refs/tags/<t>/... keep the full ref; otherwise the first segment is the ref (branch names with "/" need refs/heads/). */
function splitRef(rest: string[]): { ref: string; path: string } {
  if (rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") && rest[2]) return { ref: rest.slice(0, 3).join("/"), path: rest.slice(3).join("/") };
  return { ref: rest[0], path: rest.slice(1).join("/") };
}

export type FetchDeps = GuardDeps & { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number;
  /** Token for owner/repo on GitHub (server-side only). */ githubToken?: (repo: string) => string | undefined };

export type Fetched = { text: string; file: string; sourceUrl: string; skipped: string[] };

const GH_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

/** One guarded GET: https, public host, same-host redirects (re-checked), size cap, text only. */
async function get(url: string, deps: FetchDeps, token: string | undefined, accept: string, signal: AbortSignal): Promise<{ status: number; text: string }> {
  const f = deps.fetch ?? fetch;
  let cur = new URL(url);
  const first = cur.host;
  for (let hop = 0; ; hop++) {
    if (cur.protocol !== "https:") throw new ImportError(400, "Redirected to a non-https URL; not followed");
    try { await guardPublicHost(cur, deps, "That URL points to a local or private address, which is blocked"); }
    catch (e) { if (e instanceof BlockedHostError) throw new ImportError(400, e.message); throw e; }
    const headers: Record<string, string> = { accept, "user-agent": "cobra" };
    if (token && GH_HOSTS.has(cur.hostname)) headers.authorization = `Bearer ${token}`;
    let r: Response;
    try { r = await f(cur.toString(), { headers, redirect: "manual", signal }); }
    catch (e) {
      if (signal.aborted || (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError") throw new ImportError(504, `Timed out after ${Math.round((deps.timeoutMs ?? IMPORT_TIMEOUT_MS) / 1000)}s`);
      throw new ImportError(502, "Could not connect to that URL");
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      await r.body?.cancel().catch(() => {});
      if (!loc) throw new ImportError(502, `HTTP ${r.status} without a location`);
      const next = new URL(loc, cur);
      if (next.host !== first) throw new ImportError(400, `Redirects to another host (${next.hostname}) are not followed; use the final URL`);
      if (hop + 1 >= MAX_HOPS) throw new ImportError(400, "Too many redirects");
      cur = next; continue;
    }
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { status: r.status, text: "" }; }
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    if (ct && !/^text\/|^application\/(json|vnd\.github[^;]*|markdown|x-markdown|yaml|x-yaml|octet-stream)\b/.test(ct)) { await r.body?.cancel().catch(() => {}); throw new ImportError(415, `That URL serves ${ct.split(";")[0]}, not a text file`); }
    const max = deps.maxBytes ?? IMPORT_MAX_BYTES;
    const len = Number(r.headers.get("content-length") ?? "");
    if (len > max) { await r.body?.cancel().catch(() => {}); throw new ImportError(413, `The file is larger than ${Math.round(max / 1024)} KB`); }
    const buf = await readCapped(r, max);
    if (buf.includes(0)) throw new ImportError(415, "That URL serves a binary file, not text");
    return { status: r.status, text: new TextDecoder("utf-8").decode(buf) };
  }
}

async function readCapped(r: Response, max: number): Promise<Uint8Array> {
  if (!r.body) return new Uint8Array();
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); throw new ImportError(413, `The file is larger than ${Math.round(max / 1024)} KB`); }
    chunks.push(value);
  }
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

const statusMsg = (s: number, what: string) => s === 404 ? `${what} not found (for a private repo, add a token for it in Settings > Repos)` : s === 401 || s === 403 ? `GitHub refused access to ${what} (HTTP ${s})` : `Fetching ${what} failed (HTTP ${s})`;

/** GitHub GET with the team token first, then unauthenticated when the token is rejected (public repos keep working). */
async function ghGet(url: string, repo: string | null, deps: FetchDeps, accept: string, signal: AbortSignal) {
  const token = repo ? deps.githubToken?.(repo) : undefined;
  const r = await get(url, deps, token, accept, signal);
  if (token && (r.status === 401 || r.status === 403)) return get(url, deps, undefined, accept, signal);
  return r;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const rawUrl = (t: { owner: string; repo: string; ref: string }, path: string) => `https://raw.githubusercontent.com/${enc(t.owner)}/${enc(t.repo)}/${enc(t.ref || "HEAD")}/${enc(path)}`;

/** Picks the file to import from a folder: `prefer` (e.g. SKILL.md) when present, else the single .md file. */
export function pickFile(names: string[], prefer: string | null): string {
  const top = names.filter((n) => !n.includes("/"));
  if (prefer) { const hit = top.find((n) => n.toLowerCase() === prefer.toLowerCase()); if (hit) return hit; }
  const md = top.filter((n) => /\.md$/i.test(n) && !/^readme\.md$/i.test(n));
  if (md.length === 1) return md[0];
  const mdAll = top.filter((n) => /\.md$/i.test(n));
  if (mdAll.length === 1) return mdAll[0];
  if (!mdAll.length) throw new ImportError(400, prefer ? `No ${prefer} (or single .md file) found there` : "No .md file found there");
  throw new ImportError(400, `Several .md files found (${mdAll.join(", ")}); link to the one to import`);
}

/** Fetches the file a URL points at. `prefer` = the file name to pick from a folder or gist (SKILL.md for skills). */
export async function fetchImport(raw: unknown, prefer: string | null, deps: FetchDeps = {}): Promise<Fetched> {
  const t = normalizeImportUrl(raw);
  const sourceUrl = String(raw).trim();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? IMPORT_TIMEOUT_MS);
  try {
    if (t.kind === "url") {
      const r = await get(t.url, deps, undefined, "text/markdown, text/plain, */*", ctl.signal);
      if (r.status !== 200) throw new ImportError(502, `Fetching the URL failed (HTTP ${r.status})`);
      return { text: r.text, file: new URL(t.url).pathname.split("/").pop() || "file", sourceUrl, skipped: [] };
    }
    if (t.kind === "github-file") {
      const r = await ghGet(rawUrl(t, t.path), `${t.owner}/${t.repo}`, deps, "text/plain", ctl.signal);
      if (r.status !== 200) throw new ImportError(r.status === 404 ? 404 : 502, statusMsg(r.status, t.path));
      return { text: r.text, file: t.path.split("/").pop()!, sourceUrl, skipped: [] };
    }
    if (t.kind === "github-tree") {
      const repo = `${t.owner}/${t.repo}`;
      const files: string[] = [];
      const queue: string[] = [t.path];
      let dirs = 0;
      while (queue.length && dirs < MAX_LIST_DIRS) {
        const p = queue.shift()!; dirs++;
        const r = await ghGet(`https://api.github.com/repos/${enc(t.owner)}/${enc(t.repo)}/contents/${enc(p)}${t.ref ? `?ref=${encodeURIComponent(t.ref)}` : ""}`, repo, deps, "application/vnd.github+json", ctl.signal);
        if (r.status !== 200) { if (p === t.path) throw new ImportError(r.status === 404 ? 404 : 502, statusMsg(r.status, t.path || repo)); continue; }
        let list: Array<{ name?: string; path?: string; type?: string }>;
        try { const j = JSON.parse(r.text); list = Array.isArray(j) ? j : []; } catch { list = []; }
        if (p === t.path && !list.length) throw new ImportError(400, "That GitHub URL is not a folder; use the file's /blob/ URL");
        const rel = (x: string) => (t.path ? x.slice(t.path.length + 1) : x);
        for (const e of list) {
          if (!e.path) continue;
          if (e.type === "dir") { if (p === t.path || queue.length < MAX_LIST_DIRS) queue.push(e.path); files.push(`${rel(e.path)}/`); }
          else files.push(rel(e.path));
        }
      }
      const file = pickFile(files.filter((f) => !f.endsWith("/")), prefer);
      // Every other file, plus folders whose contents weren't listed (empty, or past the listing cap).
      const skipped = files.filter((f) => f !== file && (!f.endsWith("/") || !files.some((g) => g !== f && g.startsWith(f)))).sort();
      const r = await ghGet(rawUrl(t, t.path ? `${t.path}/${file}` : file), repo, deps, "text/plain", ctl.signal);
      if (r.status !== 200) throw new ImportError(502, statusMsg(r.status, file));
      return { text: r.text, file, sourceUrl, skipped };
    }
    const r = await get(`https://api.github.com/gists/${t.id}`, deps, undefined, "application/vnd.github+json", ctl.signal);
    if (r.status !== 200) throw new ImportError(r.status === 404 ? 404 : 502, r.status === 404 ? "Gist not found" : `Fetching the gist failed (HTTP ${r.status})`);
    let gfiles: Record<string, { filename?: string; content?: string; truncated?: boolean; size?: number }>;
    try { gfiles = (JSON.parse(r.text) as { files?: typeof gfiles }).files ?? {}; } catch { throw new ImportError(502, "GitHub returned an unreadable gist"); }
    const names = Object.keys(gfiles);
    const file = t.file && names.includes(t.file) ? t.file : pickFile(names, prefer);
    const g = gfiles[file];
    if (g.truncated || typeof g.content !== "string") throw new ImportError(413, `The file is larger than ${Math.round((deps.maxBytes ?? IMPORT_MAX_BYTES) / 1024)} KB`);
    if (Buffer.byteLength(g.content) > (deps.maxBytes ?? IMPORT_MAX_BYTES)) throw new ImportError(413, `The file is larger than ${Math.round((deps.maxBytes ?? IMPORT_MAX_BYTES) / 1024)} KB`);
    return { text: g.content, file, sourceUrl, skipped: names.filter((n) => n !== file).sort() };
  } finally { clearTimeout(timer); }
}

/** A stored source URL: https, at most 2000 chars, no credentials. null when absent. */
export function cleanSourceUrl(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > 2000) throw new ImportError(400, "sourceUrl must be an https URL");
  let u: URL; try { u = new URL(v.trim()); } catch { throw new ImportError(400, "sourceUrl must be an https URL"); }
  if (u.protocol !== "https:" || u.username || u.password) throw new ImportError(400, "sourceUrl must be an https URL");
  return u.toString();
}

/** Splits YAML frontmatter from the markdown body (real YAML parsing). */
export type Frontmatter = { ok: true; data: Record<string, unknown>; body: string } | { ok: false; error: string };
export function parseFrontmatter(text: string): Frontmatter {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { ok: false, error: "The file has no frontmatter: it must start with a --- block containing name and description" };
  let data: unknown;
  try { data = parseYaml(m[1]); } catch (e) { return { ok: false, error: `The frontmatter is not valid YAML: ${String((e as Error).message).split("\n")[0]}` }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "The frontmatter must be a YAML mapping (name: ..., description: ...)" };
  return { ok: true, data: data as Record<string, unknown>, body: t.slice(m[0].length).replace(/^\n+/, "") };
}

/** "Code Review!" -> "code-review" (a Cobra name suggestion), or "" when nothing usable remains. */
export function suggestSlug(s: string): string {
  let x = s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  x = x.replace(/^[^a-z]+/, "").slice(0, 63).replace(/-+$/, "");
  return x;
}
