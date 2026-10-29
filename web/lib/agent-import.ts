// Import a Claude Code subagent file (.claude/agents/<name>.md: YAML frontmatter name, description, optional tools
// and model, then a markdown body = the agent's instructions) from a URL into the new-agent form. Nothing is saved
// here; the normal create path (createAgent) saves it with the usual rules.
import type { DB } from "./db";
import { AGENT_DESCRIPTION_MAX, AGENT_NAME_RE, AGENT_PROMPT_MAX, getAgent } from "./agents";
import { modelAllowed } from "./agent-models";
import { fetchImport, ImportError, parseFrontmatter, suggestSlug, type FetchDeps } from "./url-import";

export type AgentFieldErrors = Partial<Record<"url" | "frontmatter" | "name" | "description" | "prompt", string>>;
export type ParsedAgent = { name: string; description: string; prompt: string; engine: "claude-code"; model: string; ignored: string[]; notes: string[]; errors: AgentFieldErrors };

const CLAUDE_ALIASES = new Set(["sonnet", "opus", "haiku"]);

/** Parses a subagent .md into agent form fields. model maps only when it is sonnet/opus/haiku and allowed on this server. */
export function parseAgentMd(text: string, env: Record<string, string | undefined> = process.env): ParsedAgent {
  const base: ParsedAgent = { name: "", description: "", prompt: "", engine: "claude-code", model: "", ignored: [], notes: [], errors: {} };
  const fm = parseFrontmatter(text);
  if (!fm.ok) return { ...base, errors: { frontmatter: fm.error } };
  const errors: AgentFieldErrors = {}, notes: string[] = [];
  const rn = fm.data.name;
  let name = typeof rn === "string" ? rn.trim() : rn == null ? "" : String(rn);
  if (!name) errors.name = "The frontmatter has no name";
  else if (!AGENT_NAME_RE.test(name)) {
    const s = suggestSlug(name);
    errors.name = `'${name}' isn't a valid Cobra agent name (lowercase letters, digits and '-', starting with a letter, 63 at most)${s ? `; try '${s}'` : ""}`;
    name = s;
  }
  const description = typeof fm.data.description === "string" ? fm.data.description.trim() : "";
  if (!description) errors.description = "The frontmatter has no description";
  else if (description.length > AGENT_DESCRIPTION_MAX) errors.description = `The description is longer than ${AGENT_DESCRIPTION_MAX} characters; shorten it`;
  const prompt = fm.body.trim();
  if (!prompt) errors.prompt = "The agent has no instructions after the frontmatter";
  else if (prompt.length > AGENT_PROMPT_MAX) errors.prompt = `The instructions are longer than ${AGENT_PROMPT_MAX} characters`;
  let model = "";
  const m = fm.data.model;
  if (m !== undefined && m !== null && m !== "") {
    const v = String(m).trim().toLowerCase();
    if (CLAUDE_ALIASES.has(v) && modelAllowed("claude-code", v, env)) model = v;
    else notes.push(v === "inherit" ? "model 'inherit' uses the default model" : `model '${String(m)}' isn't available here; using the default model`);
  }
  const ignored = Object.keys(fm.data).filter((k) => !["name", "description", "model"].includes(k));
  return { name, description, prompt, engine: "claude-code", model, ignored, notes, errors };
}

export type AgentImportResult = { ok: boolean; sourceUrl?: string; file?: string; agent?: { name: string; description: string; prompt: string; engine: string; model: string }; warnings: string[]; errors: AgentFieldErrors };

export async function importAgent(db: DB, tenantId: number, url: unknown, deps: FetchDeps, env: Record<string, string | undefined> = process.env): Promise<{ status: number; body: AgentImportResult }> {
  let f;
  try { f = await fetchImport(url, null, deps); }
  catch (e) { if (e instanceof ImportError) return { status: e.status, body: { ok: false, warnings: [], errors: { url: e.message } } }; throw e; }
  const p = parseAgentMd(f.text, env);
  const errors = { ...p.errors };
  if (!errors.name && p.name && getAgent(db, tenantId, p.name)) errors.name = `An agent named '${p.name}' already exists in your team; pick another name.`;
  const warnings: string[] = [];
  if (f.skipped.length) warnings.push(`These files were not imported: ${f.skipped.join(", ")}`);
  if (p.ignored.length) warnings.push(`Frontmatter fields ignored: ${p.ignored.join(", ")}`);
  warnings.push(...p.notes);
  return { status: 200, body: { ok: !Object.keys(errors).length, sourceUrl: f.sourceUrl, file: f.file, agent: { name: p.name, description: p.description, prompt: p.prompt, engine: p.engine, model: p.model }, warnings, errors } };
}
