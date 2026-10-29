// Import a Claude-format skill (SKILL.md: YAML frontmatter name + description, then a markdown body) from a URL.
// Nothing is saved here: the parsed fields pre-fill the normal new-skill form, which saves through createSkill.
import type { DB } from "../db";
import { fetchImport, ImportError, parseFrontmatter, suggestSlug, type FetchDeps } from "../url-import";
import { checkSkill, NAME } from "./store";

export type FieldErrors = Partial<Record<"url" | "frontmatter" | "name" | "description" | "body", string>>;
export type ParsedSkill = { name: string; description: string; body: string; ignored: string[]; errors: FieldErrors; suggestion?: string };

/** Parses SKILL.md text into the form fields plus per-field errors (no DB). */
export function parseSkillMd(text: string): ParsedSkill {
  const fm = parseFrontmatter(text);
  if (!fm.ok) return { name: "", description: "", body: text.trim() ? text : "", ignored: [], errors: { frontmatter: fm.error } };
  const errors: FieldErrors = {};
  const rawName = fm.data.name;
  let name = typeof rawName === "string" ? rawName.trim() : rawName == null ? "" : String(rawName);
  let suggestion: string | undefined;
  if (!name) errors.name = "The frontmatter has no name";
  else if (!NAME.test(name)) {
    suggestion = suggestSlug(name);
    errors.name = `'${name}' isn't a valid Cobra skill name (lowercase letters, numbers and dashes, starting with a letter, 63 at most)${suggestion ? `; try '${suggestion}'` : ""}`;
    name = suggestion || "";
  }
  const d = fm.data.description;
  const description = typeof d === "string" ? d.trim() : "";
  if (!description) errors.description = "The frontmatter has no description";
  const body = fm.body;
  if (!body.trim()) errors.body = "The skill has no instructions after the frontmatter";
  const ignored = Object.keys(fm.data).filter((k) => k !== "name" && k !== "description");
  return { name, description, body, ignored, errors, ...(suggestion ? { suggestion } : {}) };
}

export type ImportResult = { ok: boolean; sourceUrl?: string; file?: string; skill?: { name: string; description: string; body: string };
  warnings: string[]; errors: FieldErrors; validation?: string[] };

/** Fetches, parses and validates (same rules as save, name clash included). Returns pre-fill data; stores nothing. */
export async function importSkill(db: DB, tenantId: number, url: unknown, deps: FetchDeps): Promise<{ status: number; body: ImportResult }> {
  let f;
  try { f = await fetchImport(url, "SKILL.md", deps); }
  catch (e) { if (e instanceof ImportError) return { status: e.status, body: { ok: false, warnings: [], errors: { url: e.message } } }; throw e; }
  const p = parseSkillMd(f.text);
  const warnings: string[] = [];
  if (f.skipped.length) warnings.push(`These files were not imported: ${f.skipped.join(", ")}`);
  if (p.ignored.length) warnings.push(`Frontmatter fields ignored: ${p.ignored.join(", ")}`);
  const errors = { ...p.errors };
  let validation: string[] = [];
  if (!errors.frontmatter) {
    const c = checkSkill(db, tenantId, { name: p.name, description: p.description, body: p.body });
    if (!c.ok) {
      validation = c.errors;
      const clash = c.errors.find((e) => /already exists in your team/.test(e));
      if (clash && !errors.name) errors.name = clash;
      const nameErr = c.errors.find((e) => e.startsWith("Name:"));
      if (nameErr && !errors.name) errors.name = nameErr;
      const rest = c.errors.filter((e) => e !== clash && e !== nameErr);
      if (rest.length && !errors.body) errors.body = rest.join(" ");
    }
  }
  const ok = !Object.keys(errors).length;
  return { status: 200, body: { ok, sourceUrl: f.sourceUrl, file: f.file, skill: { name: p.name, description: p.description, body: p.body }, warnings, errors, ...(validation.length ? { validation } : {}) } };
}
