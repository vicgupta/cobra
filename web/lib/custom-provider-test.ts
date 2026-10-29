// "Test connection" for custom OpenAI-compatible providers. Server-side only; nothing is saved.
// GET {base}/models, then POST {base}/chat/completions with max_tokens 1 on the first model.
// https only; the host must resolve to public addresses only (no loopback / private / link-local:
// SSRF guard). COBRA_CP_TEST_ALLOW_HOSTS (comma-separated host[:port]) skips the address check for those
// hosts; it is meant for local previews against a mock server and is not set in production.
// The key is sent only as a Bearer header and never echoed: errors are reduced to fixed messages.
import { checkBaseUrl, checkModels } from "./provider-credentials";
import { CollabError } from "./collab";
import { BlockedHostError, guardPublicHost, isBlockedAddress } from "./safe-fetch";

export { isBlockedAddress };
export type TestResult = { ok: true; modelCount: number | null; ms: number; model: string } | { ok: false; error: string; ms: number };
export type TestDeps = { fetch?: typeof fetch; lookup?: (host: string) => Promise<string[]>; now?: () => number; timeoutMs?: number; allowHosts?: string[] };

async function guardHost(u: URL, deps: TestDeps) {
  try { await guardPublicHost(u, deps, "base URL must be a public host (local and private addresses are blocked)"); }
  catch (e) { if (e instanceof BlockedHostError) throw new CollabError(400, e.message); throw e; }
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
