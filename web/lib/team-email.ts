// Settings > Email: ONE kantsy.com mailbox per team (migration 37). A team lead, the designated lead or a system
// admin picks a name; Cobra calls https://api.kantsy.com POST /inbox, which returns {email, token, tier} once.
// The bearer token is stored AES-256-GCM encrypted (lib/secret-box.ts, COBRA_SECRET_KEY) and is never returned
// by any API or page again: views carry only the address, tier and who/when. Replacing it needs an explicit
// confirm; every change is written to team_email_audit. Runs of agents with "Can use team email" (or agent steps
// with `team_email: true`) get COBRA_TEAM_EMAIL / COBRA_TEAM_EMAIL_TOKEN in the step env (never argv); the
// token is in the run's redaction list.
import type { DB } from "./db";
import { CollabError, designatedLead, isSystemAdmin } from "./collab";
import { decryptSecret, encryptSecret } from "./secret-box";
import { KANTSY_API } from "./team-email-note";
export { KANTSY_API, TEAM_EMAIL_ENV, TEAM_EMAIL_TOKEN_ENV, teamEmailNote } from "./team-email-note";

export const EMAIL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{16,512}$/;

type U = { id: number; email: string; role: string; tenantId: number };
export type TeamEmailView = { address: string; tier: string | null; displayName: string | null; setAt: number; setBy: string | null };
export type TeamEmailStatus = { email: TeamEmailView | null; canEdit: boolean };

export const canManageTeamEmail = (db: DB, u: U) => isSystemAdmin(u) || u.role === "team_lead" || designatedLead(db, u.tenantId)?.id === u.id;

type Row = { address: string; token_enc: string; tier: string | null; display_name: string | null; set_at: number; set_by: string | null };
const row = (db: DB, t: number) => db.prepare("SELECT address, token_enc, tier, display_name, set_at, set_by FROM team_email WHERE tenant_id = ?").get(t) as Row | undefined;

export function teamEmailStatus(db: DB, u: U): TeamEmailStatus {
  const r = row(db, u.tenantId);
  return { email: r ? { address: r.address, tier: r.tier, displayName: r.display_name, setAt: r.set_at, setBy: r.set_by } : null, canEdit: canManageTeamEmail(db, u) };
}

const audit = (db: DB, u: U, action: string, detail: string, now: number) =>
  db.prepare("INSERT INTO team_email_audit (tenant_id, actor_id, actor_email, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(u.tenantId, u.id, u.email, action, detail.slice(0, 500), now);

export const teamEmailAudit = (db: DB, t: number) =>
  db.prepare("SELECT actor_email AS actor, action, detail, at FROM team_email_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT 20").all(t) as Array<{ actor: string; action: string; detail: string; at: number }>;

export type RequestInput = { name?: unknown; displayName?: unknown; replace?: unknown };

/** Create the team's mailbox at kantsy.com and store its token (encrypted). Replacing an existing one needs replace: true. */
export async function requestTeamEmail(db: DB, u: U, b: RequestInput, secretKey: string | undefined, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<TeamEmailStatus> {
  if (!canManageTeamEmail(db, u)) throw new CollabError(403, "only team leads, the designated lead and system admins can change the team email");
  const name = typeof b.name === "string" ? b.name.trim().toLowerCase() : "";
  if (!EMAIL_NAME_RE.test(name)) throw new CollabError(400, "name must be 2-32 lowercase letters, digits or '-' (not starting or ending with '-')");
  const displayName = typeof b.displayName === "string" && b.displayName.trim() ? b.displayName.trim() : null;
  if (displayName && (displayName.length > 60 || !/^[\x20-\x7e]+$/.test(displayName))) throw new CollabError(400, "display name must be plain ASCII, at most 60 characters");
  const cur = row(db, u.tenantId);
  if (cur && b.replace !== true) throw new CollabError(409, `this team already has ${cur.address}; confirm to replace it`);
  if (!secretKey) throw new CollabError(500, "COBRA_SECRET_KEY is not set in the server env file, so the token can't be saved");
  let res: Response;
  try {
    res = await fetchImpl(`${KANTSY_API}/inbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ...(displayName ? { display_name: displayName } : {}) }), signal: AbortSignal.timeout(15_000) });
  } catch { throw new CollabError(502, "couldn't reach kantsy.com; try again"); }
  const d = (await res.json().catch(() => null)) as { email?: unknown; token?: unknown; tier?: unknown; detail?: unknown } | null;
  if (res.status === 409) throw new CollabError(409, `${name}@kantsy.com is taken; pick another name`);
  if (res.status === 429) throw new CollabError(429, "kantsy.com rate limit (4 mailboxes a minute); wait a minute and try again");
  if (!res.ok) throw new CollabError(res.status >= 500 ? 502 : 400, `kantsy.com refused: ${typeof d?.detail === "string" ? d.detail.slice(0, 200) : `HTTP ${res.status}`}`);
  const address = typeof d?.email === "string" ? d.email.trim().toLowerCase() : "", token = typeof d?.token === "string" ? d.token.trim() : "";
  if (!/^[a-z0-9-]+@kantsy\.com$/.test(address) || !TOKEN_RE.test(token)) throw new CollabError(502, "kantsy.com returned an unexpected response");
  const enc = encryptSecret(token, secretKey);
  db.prepare(`INSERT INTO team_email (tenant_id, address, token_enc, tier, display_name, set_at, set_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET address = excluded.address, token_enc = excluded.token_enc, tier = excluded.tier, display_name = excluded.display_name, set_at = excluded.set_at, set_by = excluded.set_by`)
    .run(u.tenantId, address, enc, typeof d?.tier === "string" ? d.tier.slice(0, 20) : null, displayName, now, u.email);
  audit(db, u, cur ? "replace" : "create", cur ? `${cur.address} -> ${address}` : address, now);
  return teamEmailStatus(db, u);
}

/** Forget the team's mailbox (the token is deleted here; the mailbox itself stays at kantsy.com). */
export function removeTeamEmail(db: DB, u: U, now = Date.now()): TeamEmailStatus {
  if (!canManageTeamEmail(db, u)) throw new CollabError(403, "only team leads, the designated lead and system admins can change the team email");
  const cur = row(db, u.tenantId);
  if (!cur) throw new CollabError(404, "this team has no email set up");
  db.prepare("DELETE FROM team_email WHERE tenant_id = ?").run(u.tenantId);
  audit(db, u, "remove", cur.address, now);
  return teamEmailStatus(db, u);
}

/** Address + decrypted token for a run of team t. Never log or return to a client. */
export function teamEmailCredentials(db: DB, t: number, secretKey: string | undefined): { address: string; token: string } | null {
  const r = row(db, t);
  if (!r) return null;
  try { return { address: r.address, token: decryptSecret(r.token_enc, secretKey) }; } catch { console.error("[cobra] the team email token can't be decrypted (COBRA_SECRET_KEY changed?)"); return null; }
}

/** For the run redaction list. */
export const teamEmailSecrets = (db: DB, t: number, secretKey: string | undefined): string[] => { const c = teamEmailCredentials(db, t, secretKey); return c ? [c.token] : []; };

