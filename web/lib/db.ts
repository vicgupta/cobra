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
  // 14 (Providers): system-wide default model and effort tier per provider (NULL = the CLI's own default), and their audit trail
  (db) => db.exec(`
    CREATE TABLE provider_defaults (
      engine TEXT PRIMARY KEY CHECK (engine IN ('claude-code','codex')),
      model TEXT,
      effort TEXT CHECK (effort IS NULL OR effort IN ('low','medium','high')),
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE provider_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      engine TEXT NOT NULL,
      old_model TEXT, new_model TEXT, old_effort TEXT, new_effort TEXT,
      at INTEGER NOT NULL
    );
  `),
  // 15 (Agent description): short plain-language purpose shown on the agent card; NOT part of content_hash
  (db) => db.exec("ALTER TABLE team_agents ADD COLUMN description TEXT;"),
  // 16 (Run history): who triggered each run (email at trigger time, or "system"/a trigger type when not user-started).
  // Backfill from created_by where that user still exists; anything else is "unknown" (never guessed).
  (db) => db.exec(`
    ALTER TABLE runs ADD COLUMN triggered_by TEXT;
    UPDATE runs SET triggered_by = coalesce((SELECT email FROM users WHERE users.id = runs.created_by), 'unknown');
    CREATE INDEX runs_workflow ON runs(workflow, started_at DESC);
  `),
  // 17 (Theme): per-user Light / Dark / System preference; NULL = never chosen (browser cookie applies)
  (db) => db.exec("ALTER TABLE users ADD COLUMN theme TEXT CHECK (theme IN ('light', 'dark', 'system'));"),
  // 18 (OpenCode + Cursor engines): widen the engine CHECKs (table rebuilds, same columns and order) and add
  // encrypted per-provider secrets (CURSOR_API_KEY; AES-256-GCM with COBRA_SECRET_KEY, never shown) + an audit note column.
  (db) => db.exec(`
    CREATE TABLE team_agents_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      engine TEXT NOT NULL CHECK (engine IN ('claude-code', 'codex', 'opencode', 'cursor')),
      prompt TEXT NOT NULL,
      default_repo TEXT,
      content_hash TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model TEXT,
      description TEXT,
      UNIQUE (tenant_id, name)
    );
    INSERT INTO team_agents_new (id, tenant_id, name, engine, prompt, default_repo, content_hash, created_by, created_at, updated_at, model, description)
      SELECT id, tenant_id, name, engine, prompt, default_repo, content_hash, created_by, created_at, updated_at, model, description FROM team_agents;
    DROP TABLE team_agents;
    ALTER TABLE team_agents_new RENAME TO team_agents;
    CREATE TABLE provider_defaults_new (
      engine TEXT PRIMARY KEY CHECK (engine IN ('claude-code','codex','opencode','cursor')),
      model TEXT,
      effort TEXT CHECK (effort IS NULL OR effort IN ('low','medium','high')),
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    INSERT INTO provider_defaults_new SELECT engine, model, effort, updated_at, updated_by FROM provider_defaults;
    DROP TABLE provider_defaults;
    ALTER TABLE provider_defaults_new RENAME TO provider_defaults;
    CREATE TABLE provider_secrets (
      engine TEXT NOT NULL,
      name TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      set_at INTEGER NOT NULL,
      set_by TEXT,
      PRIMARY KEY (engine, name)
    );
    ALTER TABLE provider_audit ADD COLUMN detail TEXT;
  `),
  // 19 (Usage): display-only token usage and engine-reported cost per agent step (no budgets or limits).
  // cost_usd is NULL unless the engine reported it; old runs simply have no rows ("no data").
  (db) => db.exec(`
    CREATE TABLE run_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step_id TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      cost_usd REAL,
      cost_source TEXT CHECK (cost_source IS NULL OR cost_source IN ('reported','estimated')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX run_usage_run ON run_usage(run_id);
  `),
  // 20 (SOP skills): team-scoped skills with a JSON plan (no YAML), version history, approvals by content
  // hash, the admin rulebook, automatic reviews, opt-in review cycles and an audit log. Existing workflow
  // tables are untouched (nothing is converted).
  (db) => db.exec(`
    CREATE TABLE skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('sop','master')),
      body TEXT NOT NULL DEFAULT '',
      plan_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (tenant_id, name)
    );
    CREATE TABLE skill_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      saved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      saved_at INTEGER NOT NULL,
      note TEXT
    );
    CREATE INDEX skill_versions_skill ON skill_versions(skill_id, version);
    CREATE TABLE skill_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      approver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
      comment TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX skill_approvals_hash ON skill_approvals(skill_id, content_hash);
    CREATE TABLE skill_review_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('code','llm')),
      weight INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 10),
      advisory INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_by TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      rules_version TEXT NOT NULL,
      score INTEGER NOT NULL,
      results_json TEXT NOT NULL,
      trigger TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX skill_reviews_skill ON skill_reviews(skill_id, id);
    CREATE TABLE skill_review_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      review_id INTEGER REFERENCES skill_reviews(id) ON DELETE SET NULL,
      requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      pros_json TEXT NOT NULL,
      cons_json TEXT NOT NULL,
      corrections_json TEXT NOT NULL,
      narrative TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE skill_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      actor_id INTEGER,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      skill_id INTEGER,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
    CREATE INDEX skill_audit_skill ON skill_audit(skill_id, at);
  `),
  // 21: per-team workspaces (<COBRA_TEAMS_ROOT>/<tenant>/workspaces/<run>). Rewrites stored absolute
  // paths under the old shared dir in run logs/results to the run's team dir (the dirs are moved by
  // the deploy step; runWorkspacePath() still falls back to the old dir for anything not moved).
  (db) => {
    const root = path.resolve(process.env.COBRA_TEAMS_ROOT || "/home/cobra");
    const legacy = path.resolve(process.env.COBRA_WORKSPACES_DIR || path.join(root, "workspaces")) + "/";
    const like = "%" + legacy.replace(/[\\%_]/g, "\\$&") + "%";
    for (const t of ["runs", "run_step_events"]) {
      const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string; type: string }[]).filter((c) => /TEXT/i.test(c.type)).map((c) => c.name);
      for (const c of cols) {
        if (c === "id") continue;
        db.prepare(`UPDATE "${t}" SET "${c}" = REPLACE("${c}", ?, ? || tenant_id || '/workspaces/') WHERE "${c}" LIKE ? ESCAPE '\\' AND tenant_id IS NOT NULL`).run(legacy, root + "/", like);
      }
    }
  },
  // 22 (Notifications): system-admin daily analytics email. One settings row; every send recorded
  // (a unique (kind, send_date) index for 'daily' prevents double sends); changes audited.
  (db) => db.exec(`
    CREATE TABLE notification_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      daily_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER,
      updated_by TEXT
    );
    INSERT INTO notification_settings (id, daily_enabled) VALUES (1, 1);
    CREATE TABLE notification_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('daily','test')),
      send_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','skipped')),
      recipients TEXT NOT NULL DEFAULT '',
      error TEXT,
      triggered_by TEXT,
      at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX notification_sends_daily ON notification_sends(send_date) WHERE kind = 'daily';
    CREATE TABLE notification_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
  `),
  // 23 (Registration): magic-link invites, email-verified sign-ups, join requests, the admin sign-up toggle.
  // team_audit is rebuilt (SQLite can't alter a CHECK) with the same rows plus the registration actions.
  (db) => db.exec(`
    CREATE TABLE team_audit_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('promote','demote','designate','clear_designated',
        'invite_create','invite_revoke','invite_accept','team_create','signup_toggle',
        'join_request','join_notify','join_send_link','join_dismiss','join_expire')),
      target_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_email TEXT,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
    INSERT INTO team_audit_new (id, tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at)
      SELECT id, tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at FROM team_audit;
    DROP TABLE team_audit;
    ALTER TABLE team_audit_new RENAME TO team_audit;
    CREATE INDEX team_audit_tenant ON team_audit(tenant_id, at);
    CREATE TABLE registration_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      allow_team_signups INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER,
      updated_by TEXT
    );
    INSERT INTO registration_settings (id) VALUES (1);
    CREATE TABLE join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending','link_sent','dismissed','accepted','expired')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_by TEXT,
      decided_at INTEGER
    );
    CREATE INDEX join_requests_tenant ON join_requests(tenant_id, status);
    CREATE INDEX join_requests_email ON join_requests(email, status);
    CREATE TABLE team_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('member','team_lead')),
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by_email TEXT NOT NULL,
      join_request_id INTEGER REFERENCES join_requests(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX team_invites_tenant ON team_invites(tenant_id, created_at);
    CREATE TABLE signup_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('create_team','join')),
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      team_name TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
  `),
  // 24 (Tool updates): daily 4 AM ET update of the agent CLIs + model catalogs, stored as before/after snapshots.
  (db) => db.exec(`
    CREATE TABLE update_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER,
      updated_by TEXT
    );
    INSERT INTO update_settings (id, enabled) VALUES (1, 1);
    CREATE TABLE update_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual')),
      run_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('waiting','running','ok','partial','failed','skipped')),
      reason TEXT,
      next_try_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      triggered_by TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE UNIQUE INDEX update_runs_daily ON update_runs(run_date) WHERE kind = 'scheduled';
    CREATE TABLE update_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES update_runs(id) ON DELETE CASCADE,
      tool TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cli','catalog')),
      before TEXT,
      after TEXT,
      result TEXT NOT NULL CHECK (result IN ('changed','unchanged','rolled_back','failed','skipped')),
      method TEXT,
      detail TEXT,
      at INTEGER NOT NULL
    );
    CREATE INDEX update_items_run ON update_items(run_id);
    CREATE TABLE update_catalog_ids (tool TEXT PRIMARY KEY, ids TEXT NOT NULL, at INTEGER NOT NULL);
  `),
  // 25 (Team notifications): a daily 7 AM ET email per team (team data only). Settings default to ON with
  // recipients 'leads' (team leads + designated lead) when a team has no row. One daily send per team per
  // NY date (unique index). team_audit is rebuilt again to allow the notification actions.
  (db) => db.exec(`
    CREATE TABLE team_notification_settings (
      tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      recipients_mode TEXT NOT NULL DEFAULT 'leads' CHECK (recipients_mode IN ('leads','all')),
      updated_at INTEGER,
      updated_by TEXT
    );
    CREATE TABLE team_notification_optouts (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, user_id)
    );
    CREATE TABLE team_notification_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('daily','test')),
      send_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sending','sent','failed','skipped')),
      recipients TEXT NOT NULL DEFAULT '',
      error TEXT,
      triggered_by TEXT,
      at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX team_notification_sends_daily ON team_notification_sends(tenant_id, send_date) WHERE kind = 'daily';
    CREATE INDEX team_notification_sends_tenant ON team_notification_sends(tenant_id, at);
    CREATE TABLE team_audit_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('promote','demote','designate','clear_designated',
        'invite_create','invite_revoke','invite_accept','team_create','signup_toggle',
        'join_request','join_notify','join_send_link','join_dismiss','join_expire',
        'notify_toggle','notify_recipients','notify_optout','notify_optin','notify_test')),
      target_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_email TEXT,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
    INSERT INTO team_audit_new (id, tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at)
      SELECT id, tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at FROM team_audit;
    DROP TABLE team_audit;
    ALTER TABLE team_audit_new RENAME TO team_audit;
    CREATE INDEX team_audit_tenant ON team_audit(tenant_id, at);
  `),
  // 26 (Job 8): any team member can add repos to their team; audit of repo adds/edits/removals.
  // Repos were already per team (team_repos.tenant_id); rows without a valid team go to team 1.
  (db) => db.exec(`
    CREATE TABLE repo_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('add','edit','remove','token_set','token_clear')),
      repo TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    );
    CREATE INDEX repo_audit_tenant ON repo_audit(tenant_id, at);
    UPDATE team_repos SET tenant_id = 1 WHERE tenant_id NOT IN (SELECT id FROM tenants) AND EXISTS (SELECT 1 FROM tenants WHERE id = 1);
  `),
  // 27 (Provider manager): per-provider auth method (auto / api_key / subscription) and admin-defined custom
  // OpenAI-compatible providers run on the OpenCode engine. Credential values live (encrypted) in provider_secrets.
  (db) => db.exec(`
    CREATE TABLE provider_auth (
      engine TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('auto','api_key','subscription')),
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE custom_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      created_by TEXT,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
  `),
  // 28 (Job 11): provider credentials, auth methods and custom providers are per team. Existing rows move to
  // team 1. OpenRouter's key stays in the global provider_secrets table (its code path is on hold) and is used
  // by team 1 only. provider_audit gains tenant_id (NULL = global: provider defaults, OpenRouter).
  (db) => db.exec(`
    CREATE TABLE team_provider_secrets (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      engine TEXT NOT NULL,
      name TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      set_at INTEGER NOT NULL,
      set_by TEXT,
      PRIMARY KEY (tenant_id, engine, name)
    );
    CREATE TABLE team_provider_auth (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      engine TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('auto','api_key','subscription')),
      updated_at INTEGER NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (tenant_id, engine)
    );
    CREATE TABLE team_custom_providers (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      created_by TEXT,
      updated_at INTEGER NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (tenant_id, id)
    );
    INSERT INTO team_provider_secrets SELECT 1, engine, name, value_enc, set_at, set_by FROM provider_secrets WHERE engine <> 'openrouter' AND EXISTS (SELECT 1 FROM tenants WHERE id = 1);
    DELETE FROM provider_secrets WHERE engine <> 'openrouter' AND EXISTS (SELECT 1 FROM tenants WHERE id = 1);
    INSERT INTO team_provider_auth SELECT 1, engine, mode, updated_at, updated_by FROM provider_auth WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1);
    INSERT INTO team_custom_providers SELECT 1, id, name, base_url, models, created_at, created_by, updated_at, updated_by FROM custom_providers WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1);
    DROP TABLE provider_auth;
    DROP TABLE custom_providers;
    ALTER TABLE provider_audit ADD COLUMN tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE;
    UPDATE provider_audit SET tenant_id = 1 WHERE (detail LIKE '%API_KEY%' OR detail LIKE '%TOKEN%' OR detail LIKE 'auth method%' OR engine LIKE 'custom:%') AND engine <> 'openrouter' AND EXISTS (SELECT 1 FROM tenants WHERE id = 1);
  `),
  // 29 (agent edit/delete): soft delete. A deleted agent keeps its row (renamed to '<name>~<id>' so the slug can
  // be reused; '~' is never valid in a slug) with deleted_at/deleted_by; runs keep their 'agent:<name>' label.
  (db) => db.exec("ALTER TABLE team_agents ADD COLUMN deleted_at INTEGER; ALTER TABLE team_agents ADD COLUMN deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;"),
  // 30 (Skills folded into Agents): additive only. An agent runs its prompt OR one skill (skill_ref "sop:<id>" / "text:<file>",
  // NULL = prompt agent; existing rows stay prompt agents). Optional cron (America/New_York), off by default;
  // cron_last_fire is the claimed minute (ms) so restarts and several instances never double-fire.
  (db) => db.exec(`ALTER TABLE team_agents ADD COLUMN skill_ref TEXT;
    ALTER TABLE team_agents ADD COLUMN cron TEXT;
    ALTER TABLE team_agents ADD COLUMN cron_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE team_agents ADD COLUMN cron_mode TEXT NOT NULL DEFAULT 'simulated';
    ALTER TABLE team_agents ADD COLUMN cron_last_fire INTEGER;`),
  // 31 (Tasks): additive only. A task = an agent (+ optional one skill override) on a cron schedule
  // (America/New_York) with run criteria. Disabled by default; last_fire is the claimed minute (no double fires).
  (db) => db.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      agent TEXT NOT NULL,
      skill_ref TEXT,
      cron TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'simulated',
      repo TEXT,
      instructions TEXT,
      last_fire INTEGER,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX tasks_tenant_name ON tasks(tenant_id, name) WHERE deleted_at IS NULL;`),
  // 32 (Tasks UX): additive only. The task's latest run (for the "Last run" status on the Tasks list).
  (db) => db.exec("ALTER TABLE tasks ADD COLUMN last_run_id TEXT;"),
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
