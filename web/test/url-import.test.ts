// Import from URL (skills + agents): mocked fetch and DNS only, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { fetchImport, normalizeImportUrl, parseFrontmatter, suggestSlug, IMPORT_MAX_BYTES } from "../lib/url-import";
import { importSkill, parseSkillMd } from "../lib/skills/import";
import { createSkill, getSkill, SkillError, type Actor } from "../lib/skills/store";
import { create, detail } from "../lib/skills/service";
import { importAgent, parseAgentMd } from "../lib/agent-import";
import { agentAudit, AgentError, createAgent, getAgent, updateAgent } from "../lib/agents";
import { isBlockedAddress, testCustomProvider } from "../lib/custom-provider-test";

const FIXTURE = readFileSync(new URL("./fixtures/code-review-SKILL.md", import.meta.url), "utf8");
const TOKEN = "ghp_SECRETtoken0123456789abcdef";
const publicDns = async () => ["140.82.112.3"];

type Call = { url: string; auth: string | null };
/** Routes: url -> response factory. Records every call with its auth header. */
function mock(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    calls.push({ url, auth: h.get("authorization") });
    assert.equal(init?.redirect, "manual", "redirects are never auto-followed");
    const r = routes[url];
    return r ? r() : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
const text = (s: string, ct = "text/plain; charset=utf-8") => () => new Response(s, { headers: { "content-type": ct } });
const json = (v: unknown) => () => new Response(JSON.stringify(v), { headers: { "content-type": "application/json; charset=utf-8" } });

const RAW = "https://raw.githubusercontent.com/mattpocock/skills/refs/heads/main/skills/engineering/code-review/SKILL.md";
const CONTENTS = "https://api.github.com/repos/mattpocock/skills/contents/skills/engineering/code-review?ref=main";
const CONTENTS_AGENTS = "https://api.github.com/repos/mattpocock/skills/contents/skills/engineering/code-review/agents?ref=main";
const RAW_MAIN = "https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/code-review/SKILL.md";
const treeRoutes = {
  [CONTENTS]: json([{ name: "SKILL.md", path: "skills/engineering/code-review/SKILL.md", type: "file" }, { name: "agents", path: "skills/engineering/code-review/agents", type: "dir" }]),
  [CONTENTS_AGENTS]: json([{ name: "openai.yaml", path: "skills/engineering/code-review/agents/openai.yaml", type: "file" }]),
  [RAW_MAIN]: text(FIXTURE),
};

function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, tenant: string, role: "admin" | "team_lead" | "member" = "member") => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "default" ? undefined : `Team ${tenant}`, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t } as Actor;
  };
  return { db, a: mk("a@x.com", "default"), a2: mk("a2@x.com", "default"), b: mk("b@x.com", "other") };
}

test("URL normalization: GitHub tree/blob, raw (incl. refs/heads), gist, plain https", () => {
  assert.deepEqual(normalizeImportUrl("https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review"), { kind: "github-tree", owner: "mattpocock", repo: "skills", ref: "main", path: "skills/engineering/code-review" });
  assert.deepEqual(normalizeImportUrl("https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md"), { kind: "github-file", owner: "mattpocock", repo: "skills", ref: "main", path: "skills/engineering/code-review/SKILL.md" });
  assert.deepEqual(normalizeImportUrl(RAW), { kind: "github-file", owner: "mattpocock", repo: "skills", ref: "refs/heads/main", path: "skills/engineering/code-review/SKILL.md" });
  assert.deepEqual(normalizeImportUrl(RAW_MAIN), { kind: "github-file", owner: "mattpocock", repo: "skills", ref: "main", path: "skills/engineering/code-review/SKILL.md" });
  assert.deepEqual(normalizeImportUrl("https://gist.github.com/vic/0123456789abcdef0123"), { kind: "gist", id: "0123456789abcdef0123" });
  assert.deepEqual(normalizeImportUrl("https://example.com/skills/x.md#top"), { kind: "url", url: "https://example.com/skills/x.md" });
  for (const bad of ["http://example.com/x.md", "ftp://example.com/x", "file:///etc/passwd", "not a url", "", "https://u:p@example.com/x.md", "https://github.com/o/r/issues/1"]) assert.throws(() => normalizeImportUrl(bad), bad);
});

test("real fixture (mattpocock code-review) via raw refs/heads URL: parses end to end", async () => {
  const { db, a } = setup();
  const m = mock({ [RAW]: text(FIXTURE) });
  const r = await importSkill(db, a.tenantId, RAW, { fetch: m.f, lookup: publicDns, allowHosts: [] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body.errors));
  assert.equal(r.body.skill!.name, "code-review");
  assert.match(r.body.skill!.description, /^Review the changes since a fixed point/);
  assert.match(r.body.skill!.description, /"review since X"\.$/, "escaped quotes decoded by YAML");
  assert.ok(r.body.skill!.body.includes("→"), "UTF-8 kept");
  assert.ok(!r.body.skill!.body.startsWith("---"));
  assert.deepEqual(r.body.warnings, []);
  const s = createSkill(db, a, { ...r.body.skill!, sourceUrl: r.body.sourceUrl });
  assert.equal(s.sourceUrl, RAW);
  assert.ok(s.plan.steps.length >= 1);
});

test("GitHub tree URL: picks SKILL.md, warns about the other files (agents/openai.yaml), token sent only to GitHub hosts", async () => {
  const { db, a } = setup();
  const m = mock(treeRoutes);
  const r = await importSkill(db, a.tenantId, "https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review", { fetch: m.f, lookup: publicDns, allowHosts: [], githubToken: (repo) => (repo === "mattpocock/skills" ? TOKEN : undefined) });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.warnings, ["These files were not imported: agents/openai.yaml"]);
  assert.ok(m.calls.every((c) => c.auth === `Bearer ${TOKEN}` && /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(c.url)));
  assert.ok(!JSON.stringify(r.body).includes(TOKEN), "token never in the response");
  // blob form fetches the raw file
  const m2 = mock(treeRoutes);
  const r2 = await importSkill(db, a.tenantId, "https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md", { fetch: m2.f, lookup: publicDns, allowHosts: [] });
  assert.equal(r2.body.ok, true); assert.deepEqual(m2.calls.map((c) => c.url), [RAW_MAIN]); assert.equal(m2.calls[0].auth, null);
});

test("token rejected (401) falls back to unauthenticated for public repos; never sent to other hosts or leaked in errors", async () => {
  const { db, a } = setup();
  const calls: Call[] = [];
  const f = (async (u: string, init?: RequestInit) => { const auth = new Headers(init?.headers).get("authorization"); calls.push({ url: String(u), auth }); return auth ? new Response(`bad ${TOKEN}`, { status: 401 }) : text(FIXTURE)(); }) as typeof fetch;
  const r = await importSkill(db, a.tenantId, RAW_MAIN, { fetch: f, lookup: publicDns, allowHosts: [], githubToken: () => TOKEN });
  assert.equal(r.body.ok, true); assert.deepEqual(calls.map((c) => !!c.auth), [true, false]);
  const m = mock({ "https://example.com/x.md": text(FIXTURE) });
  await importSkill(db, a.tenantId, "https://example.com/x.md", { fetch: m.f, lookup: publicDns, allowHosts: [], githubToken: () => TOKEN });
  assert.equal(m.calls[0].auth, null, "no token to non-GitHub hosts");
  const m404 = mock({});
  const e = await importSkill(db, a.tenantId, RAW_MAIN, { fetch: m404.f, lookup: publicDns, allowHosts: [], githubToken: () => TOKEN });
  assert.equal(e.status, 404); assert.ok(!JSON.stringify(e.body).includes(TOKEN)); assert.match(e.body.errors.url!, /Settings > Repos/);
});

test("gist: finds SKILL.md (others listed as not imported); single .md otherwise; several .md asks which", async () => {
  const id = "0123456789abcdef0123";
  const api = `https://api.github.com/gists/${id}`;
  const g = (files: Record<string, string>) => mock({ [api]: json({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { filename: k, content: v, truncated: false }])) }) });
  const d = { lookup: publicDns, allowHosts: [] as string[] };
  let m = g({ "SKILL.md": FIXTURE, "helper.py": "print(1)" });
  let r = await fetchImport(`https://gist.github.com/vic/${id}`, "SKILL.md", { ...d, fetch: m.f });
  assert.equal(r.file, "SKILL.md"); assert.deepEqual(r.skipped, ["helper.py"]);
  m = g({ "mine.md": FIXTURE }); r = await fetchImport(`https://gist.github.com/vic/${id}`, "SKILL.md", { ...d, fetch: m.f }); assert.equal(r.file, "mine.md");
  m = g({ "a.md": "x", "b.md": "y" });
  await assert.rejects(fetchImport(`https://gist.github.com/vic/${id}`, null, { ...d, fetch: m.f }), /Several \.md files/);
});

test("SSRF: private/loopback hosts blocked by name, IP and DNS (before any request); shared guard keeps Test connection behavior", async () => {
  const { db, a } = setup();
  const m = mock({});
  for (const u of ["https://localhost/x.md", "https://127.0.0.1/x.md", "https://10.0.0.5/x.md", "https://[::1]/x.md", "https://169.254.169.254/latest", "https://foo.internal/x.md"]) {
    const r = await importSkill(db, a.tenantId, u, { fetch: m.f, lookup: publicDns, allowHosts: [] });
    assert.equal(r.status, 400, u); assert.match(r.body.errors.url!, /local or private/);
  }
  const r = await importSkill(db, a.tenantId, "https://evil.example/x.md", { fetch: m.f, lookup: async () => ["192.168.1.10"], allowHosts: [] });
  assert.match(r.body.errors.url!, /local or private/);
  assert.equal(m.calls.length, 0);
  const h = await importSkill(db, a.tenantId, "http://example.com/x.md", { fetch: m.f, lookup: publicDns });
  assert.match(h.body.errors.url!, /Only https/);
  assert.ok(isBlockedAddress("172.16.0.1") && !isBlockedAddress("8.8.8.8"));
  await assert.rejects(testCustomProvider({ baseUrl: "https://127.0.0.1/v1", apiKey: "k", models: "m" }, { fetch: m.f, allowHosts: [] }), /public host/);
});

test("redirects: same host re-checked and followed (max 3), other hosts and https->http refused", async () => {
  const red = (loc: string) => () => new Response(null, { status: 302, headers: { location: loc } });
  const d = { lookup: publicDns, allowHosts: [] as string[] };
  let m = mock({ "https://example.com/a.md": red("/b.md"), "https://example.com/b.md": text(FIXTURE) });
  assert.equal((await fetchImport("https://example.com/a.md", null, { ...d, fetch: m.f })).text, FIXTURE);
  m = mock({ "https://example.com/a.md": red("https://169.254.169.254/meta") });
  await assert.rejects(fetchImport("https://example.com/a.md", null, { ...d, fetch: m.f }), /another host/);
  m = mock({ "https://example.com/a.md": red("http://example.com/b.md") });
  await assert.rejects(fetchImport("https://example.com/a.md", null, { ...d, fetch: m.f }), /another host|non-https/);
  m = mock({ "https://example.com/1": red("/2"), "https://example.com/2": red("/3"), "https://example.com/3": red("/4") });
  await assert.rejects(fetchImport("https://example.com/1", null, { ...d, fetch: m.f }), /Too many redirects/);
});

test("size limit (header and streamed), binary/non-text refused, timeout", async () => {
  const d = { lookup: publicDns, allowHosts: [] as string[] };
  const big = "x".repeat(IMPORT_MAX_BYTES + 1);
  let m = mock({ "https://example.com/a.md": text(big) });
  await assert.rejects(fetchImport("https://example.com/a.md", null, { ...d, fetch: m.f }), /larger than 256 KB/);
  m = mock({ "https://example.com/a.md": () => new Response(big, { headers: { "content-type": "text/plain", "content-length": String(big.length) } }) });
  await assert.rejects(fetchImport("https://example.com/a.md", null, { ...d, fetch: m.f }), /larger than/);
  m = mock({ "https://example.com/a.png": text("PNG", "image/png") });
  await assert.rejects(fetchImport("https://example.com/a.png", null, { ...d, fetch: m.f }), /not a text file/);
  m = mock({ "https://example.com/a.bin": () => new Response(new Uint8Array([65, 0, 66]), { headers: { "content-type": "application/octet-stream" } }) });
  await assert.rejects(fetchImport("https://example.com/a.bin", null, { ...d, fetch: m.f }), /binary/);
  const slow = ((_u: string, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
  await assert.rejects(fetchImport("https://example.com/a.md", null, { ...d, fetch: slow, timeoutMs: 20 }), /Timed out/);
});

test("frontmatter + field validation: missing/invalid YAML, bad name with slug suggestion, empty description/body, ignored fields", () => {
  assert.equal(parseFrontmatter("# no frontmatter").ok, false);
  assert.match(parseSkillMd("# hi").errors.frontmatter!, /no frontmatter/);
  assert.match(parseSkillMd("---\nname: [unclosed\n---\nbody").errors.frontmatter!, /not valid YAML/);
  assert.match(parseSkillMd("---\n- a\n---\nbody").errors.frontmatter!, /mapping/);
  const p = parseSkillMd("---\nname: My Cool_Skill!\ndescription: d\nallowed-tools: Bash\nlicense: MIT\n---\n# Do\nit");
  assert.match(p.errors.name!, /isn't a valid Cobra skill name.*try 'my-cool-skill'/); assert.equal(p.name, "my-cool-skill");
  assert.deepEqual(p.ignored, ["allowed-tools", "license"]);
  assert.equal(suggestSlug("123 Go"), "go");
  const e = parseSkillMd("---\nname: x\ndescription: \"\"\n---\n\n  \n");
  assert.ok(e.errors.description && e.errors.body);
  assert.match(parseSkillMd("---\ndescription: d\n---\nb").errors.name!, /no name/);
});

test("import runs the normal skill validation; name clash; ignored-field warning", async () => {
  const { db, a } = setup();
  createSkill(db, a, { name: "code-review", description: "mine", body: "x" });
  const m = mock({ [RAW]: text(FIXTURE) });
  const r = await importSkill(db, a.tenantId, RAW, { fetch: m.f, lookup: publicDns, allowHosts: [] });
  assert.equal(r.body.ok, false); assert.match(r.body.errors.name!, /already exists in your team/);
  const m2 = mock({ "https://example.com/s.md": text("---\nname: ok-skill\ndescription: d\nlicense: MIT\n---\n## A\nx\n## B\ny") });
  const r2 = await importSkill(db, a.tenantId, "https://example.com/s.md", { fetch: m2.f, lookup: publicDns, allowHosts: [] });
  assert.equal(r2.body.ok, true); assert.deepEqual(r2.body.warnings, ["Frontmatter fields ignored: license"]);
});

test("save: source_url stored + 'imported from' audit; shown in detail; cross-team scoped; bad sourceUrl rejected", () => {
  const { db, a, b } = setup();
  const r = create(db, a, { name: "imp", description: "d", body: "do it", sourceUrl: RAW });
  assert.equal(r.status, 201);
  const id = (r.body as { skill: { id: number } }).skill.id;
  const row = db.prepare("SELECT source_url FROM skills WHERE id = ?").get(id) as { source_url: string };
  assert.equal(row.source_url, RAW);
  const aud = db.prepare("SELECT action, detail FROM skill_audit WHERE skill_id = ? ORDER BY id").all(id) as Array<{ action: string; detail: string }>;
  assert.deepEqual({ ...aud.at(-1) }, { action: "skill_import", detail: `imported from ${RAW}` });
  assert.equal(((detail(db, a, id).body as { skill: { sourceUrl: string } }).skill).sourceUrl, RAW);
  assert.equal(detail(db, b, id).status, 404, "other team can't see it");
  assert.equal(getSkill(db, b, id), null);
  assert.throws(() => createSkill(db, a, { name: "imp2", description: "d", body: "x", sourceUrl: "http://x.com/a" }), SkillError);
  assert.equal(createSkill(db, a, { name: "plain", description: "d", body: "x" }).sourceUrl, null);
  // same name in another team is fine (clash is per team)
  assert.equal(create(db, b, { name: "imp", description: "d", body: "x", sourceUrl: RAW }).status, 201);
});

const AGENT_MD = "---\nname: code-reviewer\ndescription: Reviews code for bugs\ntools: Read, Grep, Bash\nmodel: sonnet\ncolor: blue\n---\nYou are a careful reviewer.\n\n## Steps\n1. Read the diff\n";

test("agent .md parsing: name/description/prompt, model mapping, ignored tools + unknown fields", () => {
  const p = parseAgentMd(AGENT_MD, {});
  assert.deepEqual([p.name, p.description, p.engine, p.model], ["code-reviewer", "Reviews code for bugs", "claude-code", "sonnet"]);
  assert.match(p.prompt, /^You are a careful reviewer\./);
  assert.deepEqual(p.ignored, ["tools", "color"]);
  assert.deepEqual(p.errors, {});
  for (const m of ["opus", "haiku"]) assert.equal(parseAgentMd(AGENT_MD.replace("sonnet", m), {}).model, m);
  const inh = parseAgentMd(AGENT_MD.replace("sonnet", "inherit"), {}); assert.equal(inh.model, ""); assert.match(inh.notes[0], /inherit/);
  const odd = parseAgentMd(AGENT_MD.replace("sonnet", "gpt-4o"), {}); assert.equal(odd.model, ""); assert.match(odd.notes[0], /isn't available/);
  const off = parseAgentMd(AGENT_MD, { COBRA_CLAUDE_MODELS: "opus" }); assert.equal(off.model, "", "not allowed on this server -> default");
  const bad = parseAgentMd("---\nname: Code Reviewer\ndescription: \n---\n", {});
  assert.match(bad.errors.name!, /try 'code-reviewer'/); assert.ok(bad.errors.description && bad.errors.prompt);
  assert.match(parseAgentMd("no fm", {}).errors.frontmatter!, /no frontmatter/);
  assert.match(parseAgentMd(`---\nname: x\ndescription: ${"d".repeat(501)}\n---\nb`, {}).errors.description!, /500/);
});

test("agent import end to end: warnings, clash, SSRF, size, token not leaked; save records source_url + audit; permissions unchanged", async () => {
  const { db, a, a2, b } = setup();
  const url = "https://raw.githubusercontent.com/o/r/main/.claude/agents/code-reviewer.md";
  const m = mock({ [url]: text(AGENT_MD) });
  const r = await importAgent(db, a.tenantId, url, { fetch: m.f, lookup: publicDns, allowHosts: [], githubToken: () => TOKEN }, {});
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.warnings, ["Frontmatter fields ignored: tools, color"]);
  assert.ok(!JSON.stringify(r.body).includes(TOKEN)); assert.equal(m.calls[0].auth, `Bearer ${TOKEN}`);
  const ag = createAgent(db, a, { ...r.body.agent!, model: r.body.agent!.model || null, sourceUrl: r.body.sourceUrl });
  assert.equal(ag.sourceUrl, url);
  assert.deepEqual(agentAudit(db, a.tenantId, ag.name).map((x) => [x.action, x.detail]), [["agent_import", `imported from ${url}`]]);
  assert.equal(getAgent(db, b.tenantId, ag.name), null, "other team can't see it");
  assert.throws(() => updateAgent(db, a2, ag.name, { description: "x" }), (e: unknown) => e instanceof AgentError && e.status === 403, "a teammate who didn't create it can't edit");
  const clash = await importAgent(db, a.tenantId, url, { fetch: m.f, lookup: publicDns, allowHosts: [] }, {});
  assert.match(clash.body.errors.name!, /already exists/);
  const other = await importAgent(db, b.tenantId, url, { fetch: m.f, lookup: publicDns, allowHosts: [] }, {});
  assert.equal(other.body.ok, true, "same name in another team is fine");
  const ss = await importAgent(db, a.tenantId, "https://10.1.2.3/a.md", { fetch: m.f, lookup: publicDns, allowHosts: [] }, {});
  assert.match(ss.body.errors.url!, /local or private/);
  const big = mock({ "https://example.com/a.md": text("x".repeat(IMPORT_MAX_BYTES + 10)) });
  assert.equal((await importAgent(db, a.tenantId, "https://example.com/a.md", { fetch: big.f, lookup: publicDns, allowHosts: [] }, {})).status, 413);
  assert.throws(() => createAgent(db, a, { name: "z", engine: "claude-code", prompt: "p", sourceUrl: "javascript:alert(1)" }), AgentError);
  assert.equal(createAgent(db, a, { name: "plain", engine: "claude-code", prompt: "p" }).sourceUrl, null);
});

test("agent folder: single .md picked; several .md asks which", async () => {
  const c = "https://api.github.com/repos/o/r/contents/.claude/agents?ref=main";
  const d = { lookup: publicDns, allowHosts: [] as string[] };
  let m = mock({ [c]: json([{ name: "rev.md", path: ".claude/agents/rev.md", type: "file" }]), "https://raw.githubusercontent.com/o/r/main/.claude/agents/rev.md": text(AGENT_MD) });
  assert.equal((await fetchImport("https://github.com/o/r/tree/main/.claude/agents", null, { ...d, fetch: m.f })).file, "rev.md");
  m = mock({ [c]: json([{ name: "a.md", path: ".claude/agents/a.md", type: "file" }, { name: "b.md", path: ".claude/agents/b.md", type: "file" }]) });
  await assert.rejects(fetchImport("https://github.com/o/r/tree/main/.claude/agents", null, { ...d, fetch: m.f }), /Several .md files found \(a\.md, b\.md\)/);
});

test("import routes require sign-in (apiGuard), like create", () => {
  for (const f of ["app/api/skills/import/route.ts", "app/api/import/agent/route.ts"]) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(src, /const g = await apiGuard\(req\);\s*if \(g\.error\) return g\.error;/);
    assert.match(src, /u\.tenantId/);
  }
});
