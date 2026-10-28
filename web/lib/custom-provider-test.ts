// "Test connection" for custom OpenAI-compatible providers. Server-side only; nothing is saved.
// GET {base}/models, then POST {base}/chat/completions with max_tokens 1 on the first model.
// https only; the host must resolve to public addresses only (no loopback / private / link-local:
// SSRF guard). COBRA_CP_TEST_ALLOW_HOSTS (comma-separated host[:port]) skips the address check for those
// hosts; it is meant for local previews against a mock server and is not set in production.
// The key is sent only as a Bearer header and never echoed: errors are reduced to fixed messages.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkBaseUrl, checkModels } from "./provider-credentials";
import { CollabError } from "./collab";

export type TestResult = { ok: true; modelCount: number | null; ms: number; model: string } | { ok: false; error: string; ms: number };
export type TestDeps = { fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]>; now?: () => number; timeoutMs?: number; allowHosts?: string[] };

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** True for addresses a server-side request must never reach. */
export function isBlockedAddress(ip: string): boolean {
  let a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1];
  if (isIP(a) === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (isIP(a) === 6) return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("::ffff:") || a.startsWith("64:ff9b:");
  return true;
}

const envAllow = () => (process.env.COBRA_CP_TEST_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

async function guardHost(u: URL, deps: TestDeps) {
  const allow = deps.allowHosts ?? envAllow();
  if (allow.includes(u.host.toLowerCase()) || allow.includes(u.hostname.toLowerCase())) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new CollabError(400, "base URL must be a public host (local and private addresses are blocked)");
  let addrs: string[];
  try { addrs = isIP(host) ? [host] : await (deps.lookup ?? defaultLookup)(host); } catch { throw new CollabError(400, `could not resolve ${host}`); }
  if (!addrs.length || addrs.some(isBlockedAddress)) throw new CollabError(400, "base URL must be a public host (local and private addresses are blocked)");
}

function describe(status: number, body: string, model: string): string {
  if (status === 401 || status === 403) return `${status} Invalid key`;
  if (status === 404 && /model/i.test(body)) return `Model not found: ${model}`;
  if (status === 404) return "404 Not found (check the base URL; it usually ends in /v1)";
  if (status === 429) return "429 Rate limited";
  return `HTTP ${status}`;
}

/** Runs the two probe requests. Validation errors throw CollabError(400); remote failures return ok:false. */
export async function testCustomProvider(input: { baseUrl: unknown; apiKey: string | undefined; models: unknown }, deps: TestDeps = {}): Promise<TestResult> {
  const base = checkBaseUrl(input.baseUrl);
  const model = checkModels(input.models)[0];
  if (!input.apiKey) throw new CollabError(400, "enter the API key to test");
  const u = new URL(base);
  await guardHost(u, deps);
  const f = deps.fetch ?? fetch, now = deps.now ?? Date.now, t0 = now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 10_000);
  const headers = { authorization: `Bearer ${input.apiKey}`, accept: "application/json" };
  const fail = (error: string): TestResult => ({ ok: false, error, ms: now() - t0 });
  try {
    const r1 = await f(`${base}/models`, { headers, signal: ctl.signal, redirect: "manual" });
    const b1 = await r1.text().catch(() => "");
    if (r1.status >= 300 && r1.status < 400) return fail("Redirects are not followed; use the final base URL");
    if (!r1.ok) return fail(describe(r1.status, b1, model));
    let count: number | null = null, ids: string[] | null = null;
    try { const j = JSON.parse(b1) as { data?: Array<{ id?: unknown }> }; if (Array.isArray(j.data)) { ids = j.data.map((d) => String(d?.id ?? "")); count = ids.length; } } catch { /* not JSON: still try chat */ }
    if (ids && ids.length && !ids.includes(model)) return fail(`Model not found: ${model}`);
    const r2 = await f(`${base}/chat/completions`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }), signal: ctl.signal, redirect: "manual" });
    const b2 = await r2.text().catch(() => "");
    if (!r2.ok) return fail(describe(r2.status, b2, model));
    return { ok: true, modelCount: count, ms: now() - t0, model };
  } catch (e) {
    if (ctl.signal.aborted || (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError") return fail(`Timed out after ${Math.round((deps.timeoutMs ?? 10_000) / 1000)}s`);
    return fail("Could not connect");
  } finally { clearTimeout(timer); }
}
