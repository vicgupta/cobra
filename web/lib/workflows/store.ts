// Where workflows come from and who may change them:
//  - repo:     workflows/*.yaml (built-ins, read-only in the app)
//  - template: workflows/templates/*.yaml, seeded into workflow_templates (read-only, all tenants)
//  - tenant:   tenant_workflows rows (pasted/edited YAML, template copies, tenant templates)
import type { DB } from "../db";
import { checkTeamRepo } from "../repos";
import { checkLocation, GitHubStorageError, type GitHubFiles } from "./github-files";
import { canApprove, type Approver } from "./approvals";
import { contentHash, loadTemplates, loadWorkflows, parseWorkflow, templatesDir, workflowsDir, WorkflowError, type LoadedWorkflow } from "./loader";

export type Actor = Approver & { name?: string };
export type Listed = { loaded?: LoadedWorkflow; name: string; origin: LoadedWorkflow["origin"]; errors?: string[] };

/** Upserts system templates by name + content hash and marks the current one. Idempotent. */
export function seedTemplates(db: DB, dir = templatesDir(), now = Date.now()): { seeded: number; errors: string[] } {
  const { workflows, errors } = loadTemplates(dir);
  let seeded = 0;
  for (const w of workflows) {
    const r = db.prepare("INSERT OR IGNORE INTO workflow_templates (name, version, content_hash, source, current, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(w.workflow.name, w.workflow.version, w.hash, w.source, now);
    seeded += Number(r.changes);
    db.prepare("UPDATE workflow_templates SET current = (content_hash = ?) WHERE name = ?").run(w.hash, w.workflow.name);
  }
  const names = workflows.map((w) => w.workflow.name);
  db.prepare(`UPDATE workflow_templates SET current = 0 WHERE name NOT IN (${names.map(() => "?").join(",") || "''"})`).run(...names);
  return { seeded, errors: errors.map((e) => `${e.file}: ${e.errors.join("; ")}`) };
}

export function systemTemplates(db: DB): LoadedWorkflow[] {
  const rows = db.prepare("SELECT name, source FROM workflow_templates WHERE current = 1 ORDER BY name").all() as Array<{ name: string; source: string }>;
  return rows.map((r) => parseWorkflow(r.source, `templates/${r.name}.yaml`, "template"));
}

type TenantRow = { name: string; source: string; author: string | null };
function tenantRows(db: DB, tenantId: number): TenantRow[] {
  return db.prepare("SELECT w.name, w.source, u.email AS author FROM tenant_workflows w LEFT JOIN users u ON u.id = w.updated_by WHERE w.tenant_id = ? ORDER BY w.name").all(tenantId) as TenantRow[];
}
const parseTenant = (r: TenantRow): LoadedWorkflow => ({ ...parseWorkflow(r.source, `db:${r.name}`, "tenant"), author: r.author ?? undefined });

/** Everything visible to a tenant; invalid tenant rows are listed with their errors. */
export function listAll(db: DB, tenantId: number, dir = workflowsDir()): Listed[] {
  const out: Listed[] = [];
  const repo = loadWorkflows(dir);
  for (const w of repo.workflows) out.push({ loaded: w, name: w.workflow.name, origin: "repo" });
  for (const e of repo.errors) out.push({ name: e.file.split("/").pop()!.replace(/\.ya?ml$/, ""), origin: "repo", errors: e.errors });
  for (const r of tenantRows(db, tenantId)) {
    try { out.push({ loaded: parseTenant(r), name: r.name, origin: "tenant" }); }
    catch (e) { out.push({ name: r.name, origin: "tenant", errors: e instanceof WorkflowError ? e.errors : [String(e)] }); }
  }
  for (const t of systemTemplates(db)) out.push({ loaded: t, name: t.workflow.name, origin: "template" });
  return out;
}

export function findWorkflow(db: DB, tenantId: number, name: string, dir = workflowsDir()): LoadedWorkflow | null {
  return listAll(db, tenantId, dir).find((l) => l.name === name && l.loaded)?.loaded ?? null;
}

/** Owners, approvers, team leads and admins may edit a tenant workflow; anyone in the tenant may create one. */
export function canEdit(user: Actor, w: LoadedWorkflow): boolean {
  if (w.origin !== "tenant") return false;
  return user.role === "admin" || user.role === "team_lead" || user.email === w.workflow.governance.owner || canApprove(user, w.workflow.governance);
}

/** Admins, team leads, the owner and allowed approvers may run an approved workflow. */
export function canRun(user: Actor, w: LoadedWorkflow): boolean {
  // Any user of the workflow's tenant may start runs: findWorkflow is tenant-scoped (isolation), and
  // startRun separately requires this exact version to be approved. Templates never run.
  void user;
  return !w.workflow.template;
}

export class SaveError extends Error {
  constructor(public status: number, public errors: string[]) { super(errors.join("; ")); }
}

export type Storage = { kind: "database" } | { kind: "github"; repo: string; path: string; branch?: string };
type Row = { name: string; storage: "database" | "github"; github_repo: string | null; github_path: string | null; github_branch: string | null; github_sha: string | null };

export function storageOf(db: DB, tenantId: number, name: string): (Storage & { sha?: string | null; syncedAt?: number | null }) | null {
  const r = db.prepare("SELECT storage, github_repo, github_path, github_branch, github_sha, synced_at FROM tenant_workflows WHERE tenant_id = ? AND name = ?").get(tenantId, name) as
    (Row & { synced_at: number | null }) | undefined;
  if (!r) return null;
  return r.storage === "github" ? { kind: "github", repo: r.github_repo!, path: r.github_path!, branch: r.github_branch ?? undefined, sha: r.github_sha, syncedAt: r.synced_at } : { kind: "database" };
}

function parseOr400(source: string): LoadedWorkflow {
  if (source.length > 100_000) throw new SaveError(400, ["YAML is too large (max 100 KB)"]);
  try { return parseWorkflow(source.replace(/\r\n/g, "\n"), "workflow.yaml", "tenant"); }
  catch (e) { throw new SaveError(400, e instanceof WorkflowError ? e.errors : [String(e)]); }
}

async function gh<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { throw new SaveError(e instanceof GitHubStorageError ? 502 : 500, [e instanceof Error ? e.message : String(e)]); }
}

/**
 * Validates and saves a tenant workflow (or workspace template). `previousName`
 * edits an existing row (renames allowed); otherwise creates. Any content change
 * gets a new hash, so earlier approvals no longer apply. With github storage the
 * YAML is committed to repo/path first and the DB keeps a cache plus the blob sha.
 */
export async function saveTenantWorkflow(db: DB, user: Actor, source: string, opts: {
  previousName?: string; templateName?: string; repo?: string; storage?: Storage; github?: GitHubFiles; importExisting?: boolean; dir?: string; now?: number;
} = {}): Promise<LoadedWorkflow> {
  const now = opts.now ?? Date.now();
  const all = listAll(db, user.tenantId, opts.dir);
  const existing = opts.previousName ? all.find((l) => l.origin === "tenant" && l.name === opts.previousName) : undefined;
  if (opts.previousName) {
    if (!existing) throw new SaveError(404, [`workflow '${opts.previousName}' not found`]);
    if (existing.loaded && !canEdit(user, existing.loaded)) throw new SaveError(403, ["you can't edit this workflow (owner, approvers, team leads and admins can)"]);
  }
  const prev = opts.previousName ? storageOf(db, user.tenantId, opts.previousName) : null;
  const storage: Storage = opts.storage ?? prev ?? { kind: "database" };
  if (storage.kind === "github") {
    const errs = checkLocation(storage.repo, storage.path);
    const denied = checkTeamRepo(db, user.tenantId, storage.repo);
    if (denied && !errs.length) errs.push(denied);
    if (errs.length) throw new SaveError(400, errs);
    if (!opts.github) throw new SaveError(500, ["GitHub storage is not configured on this server"]);
  }
  const sameLocation = prev?.kind === "github" && storage.kind === "github" && prev.repo === storage.repo && prev.path === storage.path;
  let sha: string | null = sameLocation ? (prev as { sha?: string | null }).sha ?? null : null;

  if (opts.importExisting) {
    if (storage.kind !== "github") throw new SaveError(400, ["import needs a GitHub repo and path"]);
    const f = await gh(() => opts.github!.get(storage.repo, storage.path, storage.branch));
    if (!f) throw new SaveError(404, [`${storage.repo}/${storage.path} not found on GitHub`]);
    source = f.content; sha = f.sha;
  }
  const loaded = parseOr400(source);
  const name = loaded.workflow.name;
  if (all.some((l) => l.name === name && l.origin !== "tenant")) throw new SaveError(409, [`name: '${name}' is used by a built-in workflow or system template; pick another name`]);
  if (name !== opts.previousName && all.some((l) => l.origin === "tenant" && l.name === name)) throw new SaveError(409, [`name: a workflow named '${name}' already exists${opts.previousName ? "" : "; edit it instead"}`]);

  if (storage.kind === "github" && !opts.importExisting) {
    if (!sameLocation) {
      const cur = await gh(() => opts.github!.get(storage.repo, storage.path, storage.branch));
      if (cur) throw new SaveError(409, [`${storage.repo}/${storage.path} already exists on GitHub; import it instead of overwriting`]);
    }
    sha = (await gh(() => opts.github!.put(storage.repo, storage.path, loaded.source, { sha: sha ?? undefined, branch: storage.branch, message: `cobra: ${opts.previousName ? "update" : "add"} workflow ${name}` }))).sha;
  }
  const gcols = storage.kind === "github" ? [storage.kind, storage.repo, storage.path, storage.branch ?? null, sha, now] : ["database", null, null, null, null, null];
  if (opts.previousName) {
    db.prepare("UPDATE tenant_workflows SET name = ?, source = ?, content_hash = ?, updated_by = ?, updated_at = ?, storage = ?, github_repo = ?, github_path = ?, github_branch = ?, github_sha = ?, synced_at = ? WHERE tenant_id = ? AND name = ?")
      .run(name, loaded.source, loaded.hash, user.id, now, ...gcols, user.tenantId, opts.previousName);
  } else {
    const tpl = opts.templateName ? all.find((l) => l.name === opts.templateName && l.loaded?.workflow.template)?.loaded : undefined;
    if (opts.templateName && !tpl) throw new SaveError(404, [`template '${opts.templateName}' not found`]);
    if (opts.repo) { const d = checkTeamRepo(db, user.tenantId, opts.repo); if (d) throw new SaveError(400, [d]); }
    db.prepare(`INSERT INTO tenant_workflows (tenant_id, name, source, content_hash, template_name, template_hash, created_by, updated_by, created_at, updated_at,
      storage, github_repo, github_path, github_branch, github_sha, synced_at, repo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.tenantId, name, loaded.source, loaded.hash, opts.templateName ?? null, tpl?.hash ?? null, user.id, user.id, now, now, ...gcols, opts.repo ?? null);
  }
  return { ...loaded, file: `db:${name}`, author: user.email };
}

/** Re-reads a github-stored workflow; a changed file gets a new hash (approval resets). */
export async function syncFromGitHub(db: DB, user: Actor, name: string, github: GitHubFiles, now = Date.now()): Promise<{ changed: boolean; loaded: LoadedWorkflow }> {
  const st = storageOf(db, user.tenantId, name);
  if (!st) throw new SaveError(404, [`workflow '${name}' not found`]);
  if (st.kind !== "github") throw new SaveError(400, ["this workflow is stored in the database"]);
  const denied = checkTeamRepo(db, user.tenantId, st.repo);
  if (denied) throw new SaveError(403, [denied]);
  const w = findWorkflow(db, user.tenantId, name);
  if (w && !canEdit(user, w)) throw new SaveError(403, ["you can't sync this workflow"]);
  const f = await gh(() => github.get(st.repo, st.path, st.branch));
  if (!f) throw new SaveError(404, [`${st.repo}/${st.path} no longer exists on GitHub`]);
  const loaded = parseOr400(f.content);
  if (loaded.workflow.name !== name) throw new SaveError(400, [`name in the GitHub file is '${loaded.workflow.name}', expected '${name}'`]);
  const changed = f.sha !== st.sha;
  db.prepare("UPDATE tenant_workflows SET source = ?, content_hash = ?, github_sha = ?, synced_at = ?" + (changed ? ", updated_by = NULL, updated_at = ?" : "") + " WHERE tenant_id = ? AND name = ?")
    .run(...(changed ? [loaded.source, loaded.hash, f.sha, now, now] : [loaded.source, loaded.hash, f.sha, now]), user.tenantId, name);
  return { changed, loaded };
}

/** The repo a workflow instance is attached to (tenant workflows only). */
export function attachedRepo(db: DB, tenantId: number, name: string): string | null {
  const r = db.prepare("SELECT repo FROM tenant_workflows WHERE tenant_id = ? AND name = ?").get(tenantId, name) as { repo: string | null } | undefined;
  return r?.repo ?? null;
}

/** Instances created from a template (any version), newest first. */
export function instancesOf(db: DB, tenantId: number, templateName: string) {
  return (db.prepare("SELECT name, template_hash AS templateHash, storage, repo, created_at AS createdAt FROM tenant_workflows WHERE tenant_id = ? AND template_name = ? ORDER BY created_at DESC")
    .all(tenantId, templateName) as Array<{ name: string; templateHash: string | null; storage: string; repo: string | null; createdAt: number }>).map((r) => ({ ...r }));
}

/** A free instance name: base, base-2, base-3, ... */
export function freeName(db: DB, tenantId: number, base: string, dir?: string): string {
  const taken = new Set(listAll(db, tenantId, dir).map((l) => l.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Starting YAML for "Use template": the template text with system/template
 * flags dropped, a new name and the current user as owner. Approvers are kept.
 */
export function templateCopySource(t: LoadedWorkflow, user: Pick<Actor, "email">, newName = `${t.workflow.name}-copy`): string {
  return t.source
    .replace(/^system:\s*true\s*\n/m, "")
    .replace(/^template:\s*true\s*\n/m, "")
    .replace(/^name:\s*.*$/m, `name: ${newName}`)
    .replace(/^(\s+owner:\s*).*$/m, `$1${user.email}`);
}

export { contentHash };
