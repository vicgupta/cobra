// Add (or update) a global task template from a JSON file. No redeploy needed.
//   COBRA_DB_PATH=/var/lib/cobra/cobra.db npm run template:add -- --file template.json
//   COBRA_DB_PATH=/var/lib/cobra/cobra.db npm run template:add -- --file template.json --update
// Idempotent by slug: a second run with the same content exits 0 and does nothing.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dbPath, openDb } from "../lib/db";
import { addTaskTemplate, TemplateError } from "../lib/task-templates";

const { values } = parseArgs({
  options: { file: { type: "string" }, update: { type: "boolean", default: false } },
  allowPositionals: true,
});

try {
  if (!values.file) throw new Error("usage: npm run template:add -- --file template.json [--update]");
  const raw = readFileSync(values.file, "utf8");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error(`couldn't parse JSON in ${values.file}`); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("template file must be a JSON object");
  const db = openDb(dbPath());
  const r = addTaskTemplate(db, input as Record<string, unknown>, { update: !!values.update });
  if (r.action === "inserted") console.log(`Inserted template '${r.template.slug}' (${r.template.category})`);
  else if (r.action === "updated") console.log(`Updated template '${r.template.slug}' (${r.template.category})`);
  else console.log(`Template '${r.template.slug}' already present`);
} catch (e) {
  console.error(e instanceof TemplateError || e instanceof Error ? e.message : e);
  process.exit(1);
}
