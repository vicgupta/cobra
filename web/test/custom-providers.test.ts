// Custom OpenAI-compatible providers per team: API handlers (permissions, validation, key never returned, 409 in use,
// cross-team), audit, OpenCode env name, redaction source, and "Test connection" with mocked HTTP + SSRF guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { listProviderAudit } from "../lib/providers";
import { customEnvName, customModelIds, customProviderSecrets, opencodeCustomConfig, storedCredential } from "../lib/provider-credentials";
import { addApi, deleteApi, listApi, testDraftApi, testSavedApi, updateApi } from "../lib/custom-providers-api";
import { isBlockedAddress, testCustomProvider } from "../lib/custom-provider-test";

const SK = Buffer.alloc(32, 7).toString("base64");
const KEY = "sk-cp-TESTONLY-abcd9f3a";
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant = "a") => {
    const id = createUser(db, { email, tenant, tenantName: tenant, role, password: "pw-1234567890" });
    return { id, email, role, tenantId: (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t };
  };
  return { db, admin: mk("admin@a.com", "admin"), lead: mk("lead@a.com", "team_lead"), member: mk("m@a.com", "member"), other: mk("o@b.com", "member", "b") };
}
const body = (o: Record<string, unknown> = {}) => ({ id: "together", name: "Together AI", baseUrl: "https://api.together.example/v1/", models: "llama-3, qwen-2", apiKey: KEY, ...o });
const json = (v: unknown) => JSON.stringify(v);

test("members and leads add/list; key stored encrypted, never returned (last4 only); admins outside the team read-only", async () => {
  const { db, admin, member, lead } = setup();
  const r = await addApi(db, member, body(), SK);
  assert.equal(r.status, 201);
  assert.ok(!json(r.body).includes(KEY));
  assert.equal(storedCredential(db, member.tenantId, "custom:together", "API_KEY", SK), KEY);
  assert.ok(!json(db.prepare("SELECT * FROM team_provider_secrets").all()).includes(KEY), "encrypted at rest");
  const l = listApi(db, lead, SK) as { body: { canManage: boolean; providers: Array<{ baseUrl: string; models: string[]; key: { set: boolean; last4: string | null } }> } };
  assert.equal(l.body.canManage, true);
  assert.deepEqual(l.body.providers[0].models, ["llama-3", "qwen-2"]);
  assert.equal(l.body.providers[0].baseUrl, "https://api.together.example/v1");
  assert.equal(l.body.providers[0].key.last4, "9f3a");
  assert.ok(!json(l).includes(KEY));
  const a = listApi(db, admin, SK) as { body: { canManage: boolean; providers: Array<Record<string, unknown>> } };
  assert.equal(a.body.canManage, false);
  assert.deepEqual(a.body.providers[0].key, { set: true }, "admins get no last4");
  for (const call of [addApi(db, admin, body({ id: "x2" }), SK), updateApi(db, admin, "together", { models: "m" }, SK), deleteApi(db, admin, "together"), testDraftApi(admin, body()), testSavedApi(db, admin, "together", SK)]) assert.equal((await call).status, 403);
  assert.match(json((await testDraftApi(admin, body())).body), /Only team members can add custom providers\./);
  assert.match(readFileSync(new URL("../components/provider-credentials-form.tsx", import.meta.url), "utf8"), /Only team members can add custom providers\./);
});

test("validation: lowercase slug id unique per team, https base URL, non-empty models", async () => {
  const { db, member, other } = setup();
  const bad = async (o: Record<string, unknown>, re: RegExp) => { const r = await addApi(db, member, body(o), SK); assert.equal(r.status, 400, json(o)); assert.match(json(r.body), re); };
  await bad({ id: "Together" }, /lowercase/);
  await bad({ id: "a" }, /lowercase/);
  await bad({ id: "my_p" }, /lowercase/);
  await bad({ id: "openai" }, /built-in/);
  await bad({ baseUrl: "http://api.together.example/v1" }, /https/);
  await bad({ baseUrl: "http://localhost:8000/v1" }, /https/);
  await bad({ baseUrl: "not a url" }, /https URL/);
  await bad({ baseUrl: "https://u:p@x.example/v1" }, /credentials/);
  await bad({ models: "" }, /model/);
  await bad({ models: [] }, /model/);
  await bad({ models: "ok, bad model!" }, /invalid model/);
  await bad({ name: "" }, /name/);
  assert.equal((await addApi(db, member, null, SK)).status, 400);
  assert.equal((await addApi(db, member, body(), SK)).status, 201);
  assert.equal((await addApi(db, member, body(), SK)).status, 409, "unique per team");
  assert.equal((await addApi(db, other, body(), SK)).status, 201, "same id is fine in another team");
  assert.equal((await updateApi(db, member, "together", { baseUrl: "http://x.example" }, SK)).status, 400);
  assert.equal((await updateApi(db, member, "together", { models: " " }, SK)).status, 400);
});

test("edit models, replace and delete key; audit add/edit/remove without the key", async () => {
  const { db, member, lead } = setup();
  await addApi(db, member, body(), SK);
  const u = await updateApi(db, lead, "together", { models: ["m1"], apiKey: "sk-cp-TESTONLY-NEW-77zz" }, SK);
  assert.equal(u.status, 200); assert.ok(!json(u.body).includes("77zz"));
  assert.equal(storedCredential(db, member.tenantId, "custom:together", "API_KEY", SK), "sk-cp-TESTONLY-NEW-77zz");
  assert.deepEqual(customModelIds(db, member.tenantId), ["together/m1"]);
  await updateApi(db, lead, "together", { apiKey: null }, SK);
  assert.equal(storedCredential(db, member.tenantId, "custom:together", "API_KEY", SK), undefined);
  assert.equal((await deleteApi(db, member, "together")).status, 200);
  assert.equal(listApi(db, member, SK).body && (listApi(db, member, SK).body as { providers: unknown[] }).providers.length, 0);
  const log = json(listProviderAudit(db, member.tenantId));
  assert.match(log, /custom provider added/); assert.match(log, /custom provider edited/); assert.match(log, /custom provider removed/);
  assert.ok(!log.includes("TESTONLY"));
});

test("remove: 409 while a team agent uses one of its models; another team's agents don't count; 404 cross-team", async () => {
  const { db, member, other } = setup();
  await addApi(db, member, body(), SK);
  const ins = (t: number, name: string, model: string, deleted: number | null = null) => db.prepare("INSERT INTO team_agents (tenant_id, name, engine, prompt, content_hash, created_at, updated_at, model, deleted_at) VALUES (?, ?, 'codex', 'p', 'h', 1, 1, ?, ?)").run(t, name, model, deleted);
  ins(other.tenantId, "theirs", "together/llama-3");
  ins(member.tenantId, "gone", "together/llama-3", 5);
  ins(member.tenantId, "similar", "togetherx/llama-3");
  ins(member.tenantId, "reviewer", "together/qwen-2");
  const r = await deleteApi(db, member, "together");
  assert.equal(r.status, 409); assert.match(json(r.body), /reviewer/); assert.doesNotMatch(json(r.body), /theirs|gone|similar/);
  assert.equal((listApi(db, member, SK).body as { providers: unknown[] }).providers.length, 1, "nothing removed");
  db.prepare("UPDATE team_agents SET model = 'gpt-5' WHERE name = 'reviewer'").run();
  assert.equal((await deleteApi(db, other, "together")).status, 404, "other team can't remove ours");
  assert.equal((await updateApi(db, other, "together", { models: "m" }, SK)).status, 404);
  assert.equal((await testSavedApi(db, other, "together", SK)).status, 404);
  assert.equal((listApi(db, other, SK).body as { providers: unknown[] }).providers.length, 0);
  assert.equal((await deleteApi(db, member, "together")).status, 200);
  assert.equal(storedCredential(db, member.tenantId, "custom:together", "API_KEY", SK), undefined, "key removed with it");
});

test("key reaches OpenCode only as COBRA_CP_<ID>_KEY and is in the redaction list", async () => {
  const { db, member } = setup();
  await addApi(db, member, body({ id: "vllm-lab" }), SK);
  assert.equal(customEnvName("vllm-lab"), "COBRA_CP_VLLM_LAB_KEY");
  const c = opencodeCustomConfig(db, member.tenantId, SK);
  assert.deepEqual(Object.keys(c.env), ["COBRA_CP_VLLM_LAB_KEY"]);
  assert.ok(!json(c.config).includes(KEY), "config references {env:...} only");
  assert.match(json(c.config), /\{env:COBRA_CP_VLLM_LAB_KEY\}/);
  assert.deepEqual(customProviderSecrets(db, member.tenantId, SK), [KEY]);
  assert.match(readFileSync(new URL("../lib/workflows/server.ts", import.meta.url), "utf8"), /customProviderSecrets/);
});

// ---- Test connection (mocked HTTP) ----
type Call = { url: string; init: RequestInit };
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>, calls: Call[] = []) =>
  (async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as unknown as typeof fetch;
const publicDns = async () => ["93.184.216.34"];
const ok = (url: string) => url.endsWith("/models") ? Response.json({ data: [{ id: "llama-3" }, { id: "qwen-2" }, { id: "x" }] }) : Response.json({ choices: [{ message: { content: "p" } }] });

test("test connection: GET /models then 1-token chat completion; success reports model count and ms; key never echoed", async () => {
  const calls: Call[] = [];
  let t = 1000;
  const r = await testCustomProvider({ baseUrl: "https://api.x.example/v1", apiKey: KEY, models: ["llama-3"] }, { fetch: mockFetch(ok, calls), lookup: publicDns, now: () => (t += 206) });
  assert.deepEqual(r, { ok: true, modelCount: 3, ms: 206, model: "llama-3" });
  assert.equal(calls[0].url, "https://api.x.example/v1/models");
  assert.equal(calls[1].url, "https://api.x.example/v1/chat/completions");
  assert.equal(JSON.parse(String(calls[1].init.body)).max_tokens, 1);
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.redirect, "manual");
});

test("test connection errors: 401 invalid key, model not found, timeout, network; no key in any message", async () => {
  const run = (h: Parameters<typeof mockFetch>[0], extra = {}) => testCustomProvider({ baseUrl: "https://api.x.example/v1", apiKey: KEY, models: "llama-3" }, { fetch: mockFetch(h), lookup: publicDns, ...extra });
  const e1 = await run(() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }));
  assert.deepEqual([e1.ok, (e1 as { error: string }).error], [false, "401 Invalid key"]);
  const e2 = await run((u) => u.endsWith("/models") ? Response.json({ data: [{ id: "other" }] }) : Response.json({}));
  assert.equal((e2 as { error: string }).error, "Model not found: llama-3");
  const e3 = await run((u) => u.endsWith("/models") ? new Response("nope") : new Response('{"error":{"message":"The model llama-3 does not exist"}}', { status: 404 }));
  assert.equal((e3 as { error: string }).error, "Model not found: llama-3");
  const hang = (_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const e4 = await run(hang, { timeoutMs: 30 });
  assert.equal((e4 as { error: string }).error, "Timed out after 0s".replace("0s", `${Math.round(30 / 1000)}s`));
  assert.match(readFileSync(new URL("../lib/custom-provider-test.ts", import.meta.url), "utf8"), /timeoutMs \?\? 10_000/, "10 s default");
  const e5 = await run(() => { throw new TypeError(`fetch failed ${KEY}`); });
  assert.equal((e5 as { error: string }).error, "Could not connect");
  for (const e of [e1, e2, e3, e4, e5]) assert.ok(!json(e).includes(KEY));
});

test("test connection SSRF guard: https only, loopback/private/link-local blocked (by name and by DNS); allow-list only when configured", async () => {
  let fetched = 0;
  const f = mockFetch((u) => { fetched++; return ok(u); });
  const t = (baseUrl: string, lookup = publicDns, allowHosts: string[] = []) => testCustomProvider({ baseUrl, apiKey: KEY, models: "llama-3" }, { fetch: f, lookup, allowHosts });
  await assert.rejects(t("http://api.x.example/v1"), /https/);
  for (const u of ["https://localhost:8443/v1", "https://127.0.0.1/v1", "https://10.0.0.5/v1", "https://192.168.1.2/v1", "https://169.254.169.254/latest", "https://[::1]/v1", "https://[fd00::1]/v1", "https://x.internal/v1"]) await assert.rejects(t(u), /public host/, u);
  await assert.rejects(t("https://rebind.example/v1", async () => ["93.184.216.34", "127.0.0.1"]), /public host/);
  await assert.rejects(t("https://meta.example/v1", async () => ["::ffff:169.254.169.254"]), /public host/);
  assert.equal(fetched, 0, "no request made to blocked hosts");
  for (const ip of ["0.0.0.0", "100.64.0.1", "172.16.0.1", "172.31.255.255", "fe80::1", "224.0.0.1"]) assert.ok(isBlockedAddress(ip), ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) assert.ok(!isBlockedAddress(ip), ip);
  assert.equal((await t("https://localhost:4599/v1", publicDns, ["localhost:4599"])).ok, true, "explicit allow-list (preview only)");
  await assert.rejects(t("https://localhost:4600/v1", publicDns, ["localhost:4599"]), /public host/, "port must match");
  assert.equal(process.env.COBRA_CP_TEST_ALLOW_HOSTS, undefined, "not set in tests / prod");
});

test("test endpoints: draft uses the entered key; saved uses the stored key; nothing is saved; members only", async () => {
  const { db, member } = setup();
  const before = json(db.prepare("SELECT * FROM team_custom_providers").all());
  const calls: Call[] = [];
  const deps = { fetch: mockFetch(ok, calls), lookup: publicDns };
  const d = await testDraftApi(member, { baseUrl: "https://api.x.example/v1", apiKey: ` ${KEY} `, models: ["llama-3"] }, deps);
  assert.equal(d.status, 200); assert.equal((d.body as { ok: boolean }).ok, true);
  assert.equal(json(db.prepare("SELECT * FROM team_custom_providers").all()), before, "draft test saves nothing");
  assert.equal((await testDraftApi(member, { baseUrl: "https://api.x.example/v1", models: "m" }, deps)).status, 400, "key required");
  await addApi(db, member, body({ baseUrl: "https://api.x.example/v1", apiKey: "sk-cp-TESTONLY-stored-1111" }), SK);
  calls.length = 0;
  const s = await testSavedApi(db, member, "together", SK, deps);
  assert.equal(s.status, 200); assert.ok(!json(s.body).includes("1111"));
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer sk-cp-TESTONLY-stored-1111");
  const audits = listProviderAudit(db, member.tenantId).length;
  await testSavedApi(db, member, "together", SK, deps);
  assert.equal(listProviderAudit(db, member.tenantId).length, audits, "results not saved/audited");
  await updateApi(db, member, "together", { apiKey: null }, SK);
  assert.equal((await testSavedApi(db, member, "together", SK, deps)).status, 400);
  assert.equal((await testSavedApi(db, member, "nope", SK, deps)).status, 404);
});
