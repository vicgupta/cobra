// SQLite database (Node's built-in node:sqlite). Path: COBRA_DB_PATH, else
// web/data/cobra.db for local dev (gitignored). Migrations run on first open.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
