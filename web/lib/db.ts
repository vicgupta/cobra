// SQLite database (Node's built-in node:sqlite). Path: COBRA_DB_PATH, else
// web/data/cobra.db for local dev (gitignored). Migrations run on first open.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { seedTemplates } from "./workflows/store";

export type DB = DatabaseSync;

const MIGRATIONS: Array<(db: DB) => void> = [
  // 1: tenants, users, sessions
  (db) => db.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
      username TEXT UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','member')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
  `),
  // 2: runs (test runs; tenant-scoped rows, single-team behaviour for now)
  (db) => db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      agent TEXT NOT NULL,
      repo TEXT NOT NULL,
      issue INTEGER NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      simulated INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NOT NULL
    );
    CREATE INDEX runs_tenant ON runs(tenant_id, started_at DESC);
  `),
  // 3: email is the only user ID. Rebuild users without the username column,
  // keeping ids so sessions/runs FKs and tenant links stay valid.
  (db) => db.exec(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','member')),
      created_at INTEGER NOT NULL
    );
    INSERT INTO users_new (id, tenant_id, email, name, password_hash, role, created_at)
      SELECT id, tenant_id, lower(email), name, password_hash, role, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
  `),
  // 4: password reset by email. Only the sha256 of the emailed token is stored.
  (db) => db.exec(`
    CREATE TABLE password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX password_resets_user ON password_resets(user_id);
  `),
  // 5: session metadata for the Sessions page. Existing sessions stay valid and
  // count as "remember me" (30-day) sessions; public_id is the id shown to users
  // (the token hash in sessions.id is never sent to the browser).
  (db) => db.exec(`
    ALTER TABLE sessions ADD COLUMN public_id TEXT;
    UPDATE sessions SET public_id = lower(hex(randomblob(16)));
    CREATE UNIQUE INDEX sessions_public_id ON sessions(public_id);
    ALTER TABLE sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
    ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
    ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
    UPDATE sessions SET last_seen_at = created_at;
  `),
  // 6: DB-backed rate limits (fixed window per bucket + key). Emails are stored
  // as sha256, never raw.
  (db) => db.exec(`
    CREATE TABLE rate_limits (
      bucket TEXT NOT NULL,
      key TEXT NOT NULL,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (bucket, key)
    ) WITHOUT ROWID;
    CREATE INDEX rate_limits_expires ON rate_limits(expires_at);
  `),
  // 7: workflows. team_lead role (users rebuilt to widen the CHECK; ids kept),
  // approvals of workflow definitions by content hash, and workflow columns on runs.
  (db) => db.exec(`
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','team_lead','member')),
      created_at INTEGER NOT NULL
    );
    INSERT INTO users_new (id, tenant_id, email, name, password_hash, role, created_at)
      SELECT id, tenant_id, email, name, password_hash, role, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    CREATE TABLE workflow_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      workflow TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      approver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
      comment TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX workflow_approvals_lookup ON workflow_approvals(tenant_id, workflow, content_hash);
    ALTER TABLE runs ADD COLUMN workflow TEXT;
    ALTER TABLE runs ADD COLUMN workflow_hash TEXT;
    ALTER TABLE runs ADD COLUMN status TEXT;
    ALTER TABLE runs ADD COLUMN steps_json TEXT;
    ALTER TABLE runs ADD COLUMN outputs_json TEXT;
    ALTER TABLE runs ADD COLUMN error TEXT;
    ALTER TABLE runs ADD COLUMN ended_at INTEGER;
    -- System templates, upserted from workflows/templates/*.yaml on startup (seedTemplates).
    CREATE TABLE workflow_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      current INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (name, content_hash)
    );
    -- A tenant's own workflows (pasted YAML or copies of a template).
    CREATE TABLE tenant_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      -- Instance link: the template (name + content hash; system or workspace) this was created from.
      template_name TEXT,
      template_hash TEXT,
      -- Where the YAML lives. 'github': source is a cache of github_repo/github_path at github_sha.
      storage TEXT NOT NULL DEFAULT 'database' CHECK (storage IN ('database', 'github')),
      github_repo TEXT,
      github_path TEXT,
      github_branch TEXT,
      github_sha TEXT,
      synced_at INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, name)
    );
    -- Per-run execution log: one row per step status transition, output on terminal rows.
    CREATE TABLE run_step_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
      attempt INTEGER NOT NULL DEFAULT 0,
      output TEXT,
      truncated INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL
    );
    CREATE INDEX run_step_events_run ON run_step_events(run_id, id);
  `),
  // 8: per-team GitHub repos; engine/prompt/mode on runs; attached repo on workflow instances
  (db) => {
    db.exec(`
    CREATE TABLE team_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      default_branch TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (tenant_id, repo)
    );
    ALTER TABLE runs ADD COLUMN engine TEXT;
    ALTER TABLE runs ADD COLUMN prompt_source TEXT;
    ALTER TABLE runs ADD COLUMN mode TEXT;
    ALTER TABLE runs ADD COLUMN branch TEXT;
    ALTER TABLE tenant_workflows ADD COLUMN repo TEXT;
    `);
    const t = db.prepare("SELECT id FROM tenants WHERE slug = 'default'").get() as { id: number } | undefined;
    if (t) for (const [repo, branch] of [["vicgupta/cobra-sandbox", null], ["vicgupta/factory-demo-app", "main"]]) {
      db.prepare("INSERT OR IGNORE INTO team_repos (tenant_id, repo, default_branch, created_at) VALUES (?, ?, ?, ?)").run(t.id, repo, branch, Date.now());
    }
  },
  // 9: team agents (named engine + prompt, reusable in single runs and workflow steps)
  (db) => db.exec(`
    CREATE TABLE team_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      engine TEXT NOT NULL CHECK (engine IN ('claude-code', 'codex')),
      prompt TEXT NOT NULL,
      default_repo TEXT,
      -- sha256 of engine, newline, prompt: the prompt version.
      content_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, name)
    );
  `),
  // 10: issues and pull requests. Designated lead per team (merge rights) and an audit trail
  (db) => db.exec(`
    ALTER TABLE tenants ADD COLUMN designated_lead_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE TABLE collab_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('issue_create','agent_issue','pr_create','comment','merge')),
      repo TEXT NOT NULL,
      number INTEGER,
      run_id TEXT,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
    CREATE INDEX collab_audit_item ON collab_audit(tenant_id, repo, number, at);
  `),
  // 11: optional per-repo GitHub PAT (AES-256-GCM, COBRA_SECRET_KEY); only last 4 shown. Null = use GITHUB_TOKEN.
  (db) => db.exec(`
    ALTER TABLE team_repos ADD COLUMN pat_enc TEXT;
    ALTER TABLE team_repos ADD COLUMN pat_last4 TEXT;
    ALTER TABLE team_repos ADD COLUMN pat_set_at INTEGER;
  `),
  // 12 (Job 23): per-agent model; NULL = the engine's default model
  (db) => db.exec("ALTER TABLE team_agents ADD COLUMN model TEXT;"),
  // 13 (Job 25): audit trail for team role and designated-lead changes (collab_audit's CHECK is per-repo actions)
  (db) => db.exec(`
    CREATE TABLE team_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('promote','demote','designate','clear_designated')),
      target_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_email TEXT,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
    CREATE INDEX team_audit_tenant ON team_audit(tenant_id, at);
  `),
];

/** Runs pending migrations (up to `target`, for tests). */
export function migrate(db: DB, target = MIGRATIONS.length): void {
  // Foreign keys are off while migrating (needed for table rebuilds) and checked before commit.
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const { user_version: v } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = v; i < target; i++) {
    db.exec("BEGIN");
    try {
      MIGRATIONS[i](db);
      if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error(`Migration ${i + 1} broke foreign keys`);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  db.exec("PRAGMA foreign_keys = ON");
}

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  migrate(db);
  return db;
}

export function dbPath(): string {
  return process.env.COBRA_DB_PATH || path.join(process.cwd(), "data", "cobra.db");
}

const g = globalThis as unknown as { __cobraDb?: DB };
export function getDb(): DB {
  if (!g.__cobraDb) {
    g.__cobraDb = openDb(dbPath());
    importLegacyRuns(g.__cobraDb);
    // System workflow templates: upsert from workflows/templates/*.yaml (name + content hash).
    const { errors } = seedTemplates(g.__cobraDb);
    for (const e of errors) console.error(`workflow template not seeded: ${e}`);
  }
  return g.__cobraDb;
}

/** One-time move of web/data/runs.json (simulated runs) into the default tenant. */
function importLegacyRuns(db: DB) {
  const file = path.join(process.cwd(), "data", "runs.json");
  if (!existsSync(file)) return;
  const t = db.prepare("SELECT id FROM tenants WHERE slug = 'default'").get() as { id: number } | undefined;
  const any = db.prepare("SELECT 1 FROM runs LIMIT 1").get();
  if (!t || any) return;
  try {
    const rows = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
    const ins = db.prepare("INSERT OR IGNORE INTO runs (id, tenant_id, agent, repo, issue, title, prompt, simulated, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)");
    for (const r of rows) ins.run(String(r.id), t.id, String(r.agent), String(r.repo), Number(r.issue), String(r.title), String(r.prompt ?? ""), Number(r.startedAt));
  } catch {
    // Unreadable legacy file: ignore.
  }
}
