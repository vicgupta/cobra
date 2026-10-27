// Codex (Subscription): a pasted ChatGPT login, stored per team in the CODEX_ACCESS_TOKEN slot and handed to the
// codex CLI the way it expects it: an auth.json in a per-run CODEX_HOME.
//
// Why not the CODEX_ACCESS_TOKEN env var: codex 0.164.0 reads that variable as an agent-identity JWT, not a
// ChatGPT access token, so a pasted ChatGPT token there is ignored and every request fails "401 Missing bearer"
// (diagnosed on nova 2026-10-27). Verified live the same day: the CLI accepts a CODEX_HOME/auth.json in the
// shape it writes itself (auth_mode "chatgpt", tokens.{id_token, access_token, refresh_token, account_id},
// last_refresh), also when only an access token is known (id_token = the access token, refresh_token "").
//
// Accepted input (Settings > Providers > Codex):
//   - the full contents of ~/.codex/auth.json after `codex login` (preferred: has a refresh token, so the CLI
//     renews the login itself and Cobra saves the renewed file back after each run), or
//   - a bare ChatGPT access token (works until it expires, typically ~10 days; no auto-refresh).
// Token values are never logged or returned to the browser: views carry plan, expiry and refresh ability only.
import { CollabError } from "./collab";

export const CODEX_LOGIN_SLOT = "CODEX_ACCESS_TOKEN";
const ISSUER = "https://auth.openai.com";
const MAX_LEN = 20_000;
const AUTH_CLAIM = "https://api.openai.com/auth";

type Claims = { iss?: unknown; exp?: unknown; [AUTH_CLAIM]?: { chatgpt_plan_type?: unknown; chatgpt_account_id?: unknown } };
export type CodexTokens = { id_token: string; access_token: string; refresh_token: string; account_id?: string | null; [k: string]: unknown };
export type CodexAuthJson = { auth_mode?: string; OPENAI_API_KEY?: string | null; tokens: CodexTokens; last_refresh?: string; [k: string]: unknown };
export type CodexLoginStatus = { kind: "auth_json" | "token"; plan: string | null; expiresAt: number | null; canRefresh: boolean; expired: boolean };

const bad = (msg: string): never => { throw new CollabError(400, msg); };

/** JWT payload, or null when the string isn't a decodable JWT. The signature isn't checked (the CLI and OpenAI do that). */
export function jwtClaims(t: unknown): Claims | null {
  if (typeof t !== "string") return null;
  const p = t.split(".");
  if (p.length !== 3 || !p[1]) return null;
  try { const c = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")); return c && typeof c === "object" && !Array.isArray(c) ? c : null; } catch { return null; }
}

const expMs = (c: Claims) => (typeof c.exp === "number" ? c.exp * 1000 : null);
const fromOpenAI = (c: Claims) => typeof c.iss === "string" && c.iss.replace(/\/+$/, "") === ISSUER;
const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function checkAccessToken(tok: unknown, now: number, allowExpired: boolean, where: string): Claims {
  const c = jwtClaims(tok);
  if (!c) bad(`${where} isn't a ChatGPT access token (expected a JWT: three dot-separated parts)`);
  if (!fromOpenAI(c!)) bad(`${where} wasn't issued by ${ISSUER}: paste the login from \`codex login\` (ChatGPT), not another provider's token`);
  const exp = expMs(c!);
  if (exp === null) bad(`${where} has no expiry claim; it isn't a ChatGPT login token`);
  if (!allowExpired && exp! <= now) bad(`${where} expired on ${fmtDate(exp!)}: run \`codex login\` again and paste the new ~/.codex/auth.json`);
  return c!;
}

/** Normalized auth.json object from a stored value (auth.json text or a bare access token); null when unusable. */
export function readCodexLogin(stored: string | undefined): { json: CodexAuthJson; kind: "auth_json" | "token"; claims: Claims } | null {
  if (!stored) return null;
  const s = stored.trim();
  if (s.startsWith("{")) {
    let j: CodexAuthJson;
    try { j = JSON.parse(s); } catch { return null; }
    const c = jwtClaims(j?.tokens?.access_token);
    return c ? { json: j, kind: "auth_json", claims: c } : null;
  }
  const c = jwtClaims(s);
  if (!c) return null;
  const acct = c[AUTH_CLAIM]?.chatgpt_account_id;
  // Variant verified live against codex 0.164.0: the access token doubles as id_token; no refresh token.
  return { kind: "token", claims: c, json: { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: s, access_token: s, refresh_token: "", account_id: typeof acct === "string" ? acct : null }, last_refresh: "" } };
}

/** Validate a pasted login; returns the exact string to store (compact auth.json, or the bare token). Throws 400 with a clear message. */
export function parseCodexLogin(raw: unknown, now = Date.now()): string {
  if (typeof raw !== "string") bad("value must be a string, or null to delete");
  const s = (raw as string).trim();
  if (!s) bad("paste the contents of ~/.codex/auth.json (or a ChatGPT access token)");
  if (s.length > MAX_LEN) bad(`that's too long for a Codex login (${s.length} characters; ~/.codex/auth.json is usually under 10,000)`);
  if (/^sk-/.test(s)) bad("that's an OpenAI API key, not a ChatGPT login: switch Codex to API key and paste it under OpenAI API key");
  if (/^[[{]/.test(s)) {
    let j: unknown;
    try { j = JSON.parse(s); } catch { bad("that looks like JSON but doesn't parse: paste the whole ~/.codex/auth.json file, from the first { to the last }"); }
    const o = j as Partial<CodexAuthJson>;
    if (!o || typeof o !== "object" || Array.isArray(o)) bad("auth.json must be a JSON object");
    if (o.auth_mode !== undefined && o.auth_mode !== "chatgpt") bad(`this auth.json is an "${String(o.auth_mode)}" login, not a ChatGPT one: run \`codex login\` (sign in with ChatGPT) and paste the new file, or use the API key method`);
    if (!o.tokens || typeof o.tokens !== "object") bad(o.OPENAI_API_KEY ? "this auth.json holds an API key, not a ChatGPT login: use the API key method instead" : "this auth.json has no \"tokens\" section: run `codex login` (sign in with ChatGPT) and paste ~/.codex/auth.json");
    const t = o.tokens as Partial<CodexTokens>;
    for (const k of ["id_token", "access_token"] as const) if (typeof t[k] !== "string" || !t[k]) bad(`this auth.json is missing tokens.${k}`);
    if (t.refresh_token !== undefined && typeof t.refresh_token !== "string") bad("tokens.refresh_token in this auth.json isn't a string");
    const canRefresh = !!t.refresh_token;
    // With a refresh token the CLI renews an expired access token itself, so only reject expiry when it can't.
    checkAccessToken(t.access_token, now, canRefresh, "tokens.access_token");
    if (!jwtClaims(t.id_token)) bad("tokens.id_token in this auth.json isn't a JWT");
    return JSON.stringify({ ...o, auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { ...t, refresh_token: t.refresh_token ?? "" } });
  }
  if (/\s/.test(s)) bad("a ChatGPT access token has no spaces or line breaks: paste either the token alone or the whole ~/.codex/auth.json");
  checkAccessToken(s, now, false, "this token");
  return s;
}

/** Masked status for the UI: never includes a token. */
export function codexLoginStatus(stored: string | undefined, now = Date.now()): CodexLoginStatus | null {
  const l = readCodexLogin(stored);
  if (!l) return null;
  const plan = l.claims[AUTH_CLAIM]?.chatgpt_plan_type;
  const exp = expMs(l.claims);
  return { kind: l.kind, plan: typeof plan === "string" ? plan : null, expiresAt: exp, canRefresh: !!l.json.tokens.refresh_token, expired: exp !== null && exp <= now };
}

/** auth.json text to write into a run's CODEX_HOME (mode 600). */
export function buildAuthJson(stored: string, now = Date.now()): string {
  const l = readCodexLogin(stored);
  if (!l) throw new Error("the stored Codex ChatGPT login can't be read: a team member pastes ~/.codex/auth.json again in Settings > Providers");
  const j = l.kind === "token" ? { ...l.json, last_refresh: new Date(now).toISOString() } : l.json;
  return JSON.stringify(j, null, 2);
}

/** After a run: the CLI's auth.json when it refreshed the tokens (stored-form string), else null. */
export function refreshedLogin(before: string, after: string | null): string | null {
  if (!after) return null;
  const a = readCodexLogin(after), b = readCodexLogin(before);
  if (!a || a.kind !== "auth_json" || !b) return null;
  const t = (x: CodexTokens) => `${x.access_token}\n${x.refresh_token}\n${x.id_token}`;
  if (t(a.json.tokens) === t(b.json.tokens)) return null;
  try { return parseCodexLogin(after); } catch { return null; }
}

/** Every token inside a stored login (for log redaction). */
export function codexLoginSecrets(stored: string | undefined): string[] {
  const l = readCodexLogin(stored);
  if (!l) return stored ? [stored] : [];
  const t = l.json.tokens;
  return [stored!, t.access_token, t.id_token, t.refresh_token].filter((v): v is string => typeof v === "string" && v.length >= 8);
}
