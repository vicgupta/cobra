// Self-serve registration (Job 3). Three ways in, all email-bound and audited in team_audit:
//  1. Invites: a team lead or system admin sends a single-use magic link (7 days, sha256-hashed,
//     bound to the invited email, revocable). Role member; team_lead only when an admin invites.
//  2. Create a new team: email, name, password, team name. Nothing is created until the email's
//     one-time link is confirmed; then a team (unique slug) and its creator (team_lead + designated
//     lead, never admin) are created. Admin toggle "Allow new team sign-ups" (default ON).
//  3. Join an existing team: email, name and a typed team name or slug. Confirming the email only
//     creates a PENDING join request (response is always generic); the team's leads get an email and
//     a lead/admin sends a magic link (1.) or dismisses it. Unverified/unanswered requests expire in 14 days.
// No public endpoint reveals whether an account or a team exists. Mail is injected (tests use a mock).
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "./db";
import { hashPassword } from "./auth/password";
import { EMAIL_RE, MIN_PASSWORD } from "./auth/users";
import { consume, emailKey, LIMITS } from "./auth/rate-limit";
import { CollabError, designatedLead, isSystemAdmin, teamLeads } from "./collab";

export type Send = (to: string, subject: string, body: string) => Promise<void>;
export type RegActor = { id: number; email: string; role: string; tenantId: number };

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const JOIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const CREATE_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_EMAIL = 3;
export const MAX_PENDING_PER_TEAM = 25;
const MAX_OPEN_VERIFICATIONS_PER_EMAIL = 5;
export const publicBase = () => (process.env.COBRA_PUBLIC_URL || "https://nova.kantsy.com").replace(/\/$/, "");

export const GENERIC_CREATE = "Check your email: we sent a link to confirm your address and create your team. It expires in 24 hours.";
export const GENERIC_JOIN = "Check your email to confirm your address. If that team exists, its lead will be notified and can send you an invite link.";
export const GENERIC_JOIN_CONFIRMED = "Thanks, your email is confirmed. If that team exists, its lead will be notified and can send you an invite link.";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const norm = (e: unknown) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
const userExists = (db: DB, email: string) => !!db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
const freshRole = (db: DB, u: RegActor) => (db.prepare("SELECT role FROM users WHERE id = ?").get(u.id) as { role: string } | undefined)?.role ?? u.role;
const mailSafe = (send: Send, to: string, s: string, b: string) => send(to, s, b).then(() => null, (e: unknown) => { console.error("registration email:", e instanceof Error ? e.message : e); return e instanceof Error ? e.message : String(e); });

function audit(db: DB, tenantId: number, actor: { id: number | null; email: string }, action: string, target: { id?: number | null; email?: string | null } | null, detail = "", now = Date.now()) {
  db.prepare("INSERT INTO team_audit (tenant_id, actor_id, actor_email, action, target_id, target_email, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(tenantId, actor.id, actor.email, action, target?.id ?? null, target?.email ?? null, detail.slice(0, 500), now);
}

function canInvite(db: DB, u: RegActor): { admin: boolean } {
  const role = freshRole(db, u);
  const admin = isSystemAdmin({ role });
  if (!admin && role !== "team_lead") throw new CollabError(403, "only team leads and system admins can invite people");
  return { admin };
}

// ---------- the admin toggle ----------
export function signupsAllowed(db: DB): boolean {
  return ((db.prepare("SELECT allow_team_signups v FROM registration_settings WHERE id = 1").get() as { v: number } | undefined)?.v ?? 1) === 1;
}
export function signupSettings(db: DB) {
  const r = db.prepare("SELECT allow_team_signups v, updated_at at, updated_by by FROM registration_settings WHERE id = 1").get() as { v: number; at: number | null; by: string | null } | undefined;
  return { allowTeamSignups: (r?.v ?? 1) === 1, updatedAt: r?.at ?? null, updatedBy: r?.by ?? null };
}
export function setSignupsAllowed(db: DB, u: RegActor, allow: unknown, now = Date.now()) {
  if (!isSystemAdmin({ role: freshRole(db, u) })) throw new CollabError(403, "only system admins can change sign-up settings");
  if (typeof allow !== "boolean") throw new CollabError(400, "allow must be true or false");
  db.prepare("UPDATE registration_settings SET allow_team_signups = ?, updated_at = ?, updated_by = ? WHERE id = 1").run(allow ? 1 : 0, now, u.email);
  audit(db, u.tenantId, u, "signup_toggle", null, `allow new team sign-ups: ${allow ? "on" : "off"}`, now);
  return signupSettings(db);
}

// ---------- slugs ----------
export function slugify(name: string): string {
  const s = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return s || "team";
}
const RESERVED = new Set(["default", "admin", "api", "system", "cobra"]);
export function uniqueSlug(db: DB, name: string): string {
  const base = slugify(name);
  for (let i = 1; ; i++) {
    const s = i === 1 && !RESERVED.has(base) ? base : `${base}-${i}`;
    if (i === 1 && RESERVED.has(base)) continue;
    if (!db.prepare("SELECT 1 FROM tenants WHERE slug = ?").get(s)) return s;
  }
}

/** A team by its exact slug, or by a case-insensitive name that matches exactly one team. */
export function findTeam(db: DB, query: string): { id: number; name: string } | null {
  const q = clean(query, 80);
  if (!q) return null;
  const bySlug = db.prepare("SELECT id, name FROM tenants WHERE slug = ?").get(q.toLowerCase()) as { id: number; name: string } | undefined;
  if (bySlug) return { id: bySlug.id, name: bySlug.name };
  const byName = db.prepare("SELECT id, name FROM tenants WHERE lower(name) = lower(?) LIMIT 2").all(q) as Array<{ id: number; name: string }>;
  return byName.length === 1 ? { id: byName[0].id, name: byName[0].name } : null;
}

// ---------- invites (magic links) ----------
export type InviteRow = { id: number; email: string; role: string; createdBy: string; createdAt: number; expiresAt: number; usedAt: number | null; revokedAt: number | null; joinRequestId: number | null; status: "active" | "used" | "revoked" | "expired" };
export function listInvites(db: DB, tenantId: number, now = Date.now(), limit = 50): InviteRow[] {
  const rows = db.prepare("SELECT id, email, role, created_by_email createdBy, created_at createdAt, expires_at expiresAt, used_at usedAt, revoked_at revokedAt, join_request_id joinRequestId FROM team_invites WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(tenantId, limit) as Array<Omit<InviteRow, "status">>;
  return rows.map((r) => ({ ...r, status: r.usedAt ? "used" : r.revokedAt ? "revoked" : r.expiresAt <= now ? "expired" : "active" }));
}

function inviteEmail(teamName: string, inviter: string, tok: string) {
  return {
    subject: `You're invited to join ${teamName} on Cobra`,
    body: [`${inviter} invited you to join the team "${teamName}" on Cobra.`, "", "To create your account, open this link:", `${publicBase()}/register?invite=${tok}`, "",
      "The link works once, only for this email address, and expires in 7 days.", "", "If you weren't expecting this, you can ignore this email.", "", "Cobra"].join("\n"),
  };
}

function issueInvite(db: DB, u: RegActor, email: string, role: "member" | "team_lead", joinRequestId: number | null, now: number): { id: number; token: string } {
  const tok = token();
  // One live link per (team, email): older unused links are revoked.
  db.prepare("UPDATE team_invites SET revoked_at = ? WHERE tenant_id = ? AND email = ? AND used_at IS NULL AND revoked_at IS NULL").run(now, u.tenantId, email);
  const id = Number(db.prepare("INSERT INTO team_invites (tenant_id, email, role, token_hash, created_by, created_by_email, join_request_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(u.tenantId, email, role, hash(tok), u.id, u.email, joinRequestId, now, now + INVITE_TTL_MS).lastInsertRowid);
  audit(db, u.tenantId, u, "invite_create", { email }, `role ${role}${joinRequestId ? `, for join request #${joinRequestId}` : ""}, expires in 7 days`, now);
  return { id, token: tok };
}

/** Team leads (own team) and system admins: email a magic link to any address. */
export async function createInvite(db: DB, u: RegActor, body: { email?: unknown; role?: unknown }, send: Send, now = Date.now()) {
  const { admin } = canInvite(db, u);
  const email = norm(body.email);
  if (!EMAIL_RE.test(email)) throw new CollabError(400, "enter a valid email");
  const role = body.role === undefined || body.role === "member" ? "member" : body.role === "team_lead" ? "team_lead" : null;
  if (!role) throw new CollabError(400, "role must be member or team_lead");
  if (role === "team_lead" && !admin) throw new CollabError(403, "only system admins can invite a team lead");
  if (userExists(db, email)) throw new CollabError(409, "that email already has a Cobra account");
  if (consume(db, LIMITS.inviteUser, `u${u.id}`, now).limited) throw new CollabError(429, "too many invites sent; try again later");
  const team = (db.prepare("SELECT name FROM tenants WHERE id = ?").get(u.tenantId) as { name: string }).name;
  const inv = issueInvite(db, u, email, role, null, now);
  const m = inviteEmail(team, u.email, inv.token);
  const mailError = await mailSafe(send, email, m.subject, m.body);
  return { id: inv.id, email, role, mailError };
}

export function revokeInvite(db: DB, u: RegActor, id: number, now = Date.now()) {
  canInvite(db, u);
  const r = db.prepare("SELECT id, email FROM team_invites WHERE id = ? AND tenant_id = ? AND used_at IS NULL AND revoked_at IS NULL").get(id, u.tenantId) as { id: number; email: string } | undefined;
  if (!r) throw new CollabError(404, "no such active invite on this team");
  db.prepare("UPDATE team_invites SET revoked_at = ? WHERE id = ?").run(now, id);
  audit(db, u.tenantId, u, "invite_revoke", { email: r.email }, `invite #${id}`, now);
}

export const INVITE_ERRORS = {
  unknown: "This invite link isn't valid. Ask your team lead for a new one.",
  expired: "This invite link has expired. Ask your team lead for a new one.",
  used: "This invite link has already been used. Sign in instead, or ask for a new link.",
  revoked: "This invite link was cancelled. Ask your team lead for a new one.",
} as const;
export type InviteCheck = { ok: true; id: number; tenantId: number; teamName: string; email: string; role: "member" | "team_lead"; joinRequestId: number | null } | { ok: false; error: string };

export function checkInvite(db: DB, tok: unknown, now = Date.now()): InviteCheck {
  if (typeof tok !== "string" || !tok || tok.length > 200) return { ok: false, error: INVITE_ERRORS.unknown };
  const r = db.prepare("SELECT i.id, i.tenant_id tenantId, t.name teamName, i.email, i.role, i.expires_at expiresAt, i.used_at usedAt, i.revoked_at revokedAt, i.join_request_id joinRequestId FROM team_invites i JOIN tenants t ON t.id = i.tenant_id WHERE i.token_hash = ?").get(hash(tok)) as
    { id: number; tenantId: number; teamName: string; email: string; role: "member" | "team_lead"; expiresAt: number; usedAt: number | null; revokedAt: number | null; joinRequestId: number | null } | undefined;
  if (!r) return { ok: false, error: INVITE_ERRORS.unknown };
  if (r.usedAt) return { ok: false, error: INVITE_ERRORS.used };
  if (r.revokedAt) return { ok: false, error: INVITE_ERRORS.revoked };
  if (r.expiresAt <= now) return { ok: false, error: INVITE_ERRORS.expired };
  if (userExists(db, r.email)) return { ok: false, error: INVITE_ERRORS.used };
  return { ok: true, id: r.id, tenantId: r.tenantId, teamName: r.teamName, email: r.email, role: r.role, joinRequestId: r.joinRequestId };
}

/** /register?invite=…: creates the account (email from the invite) and returns its id. Atomic, single-use. */
export function acceptInvite(db: DB, tok: unknown, body: { name?: unknown; password?: unknown }, now = Date.now()): { ok: true; userId: number } | { ok: false; status: number; error: string } {
  const name = clean(body.name, 100), password = typeof body.password === "string" ? body.password : "";
  if (!name) return { ok: false, status: 400, error: "Enter your name" };
  if (password.length < MIN_PASSWORD) return { ok: false, status: 400, error: `Password must be at least ${MIN_PASSWORD} characters` };
  const pw = hashPassword(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    const c = checkInvite(db, tok, now);
    if (!c.ok) { db.exec("ROLLBACK"); return { ok: false, status: 400, error: c.error }; }
    const upd = db.prepare("UPDATE team_invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").run(now, c.id);
    if (!upd.changes) { db.exec("ROLLBACK"); return { ok: false, status: 400, error: INVITE_ERRORS.used }; }
    const userId = Number(db.prepare("INSERT INTO users (tenant_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(c.tenantId, c.email, name, pw, c.role, now).lastInsertRowid);
    db.prepare("UPDATE team_invites SET revoked_at = ? WHERE tenant_id = ? AND email = ? AND used_at IS NULL AND revoked_at IS NULL").run(now, c.tenantId, c.email);
    if (c.joinRequestId) db.prepare("UPDATE join_requests SET status = 'accepted', decided_at = coalesce(decided_at, ?) WHERE id = ?").run(now, c.joinRequestId);
    db.prepare("UPDATE join_requests SET status = 'accepted' WHERE tenant_id = ? AND email = ? AND status IN ('pending','link_sent')").run(c.tenantId, c.email);
    audit(db, c.tenantId, { id: userId, email: c.email }, "invite_accept", { id: userId, email: c.email }, `invite #${c.id}, role ${c.role}${c.joinRequestId ? `, join request #${c.joinRequestId}` : ""}`, now);
    db.exec("COMMIT");
    return { ok: true, userId };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ---------- public sign-up requests (create team / join team) ----------
function verifyEmail(kind: "create_team" | "join", tok: string) {
  const link = `${publicBase()}/register/confirm?token=${tok}`;
  return kind === "create_team"
    ? { subject: "Confirm your email to create your Cobra team", body: ["Someone (hopefully you) asked to create a team on Cobra with this email address.", "", "To confirm and create the team, open this link:", link, "", "The link works once and expires in 24 hours. If you didn't ask for this, ignore this email: nothing is created.", "", "Cobra"].join("\n") }
    : { subject: "Confirm your email to request to join a Cobra team", body: ["Someone (hopefully you) asked to join a team on Cobra with this email address.", "", "To confirm, open this link:", link, "", "After you confirm, the team's lead is notified and can send you an invite link. The link expires in 14 days. If you didn't ask for this, ignore this email.", "", "Cobra"].join("\n") };
}
const alreadyHaveAccount = () => ({ subject: "You already have a Cobra account", body: ["Someone (hopefully you) tried to sign up on Cobra with this email address, but it already has an account.", "", `Sign in at ${publicBase()}/login (use "Forgot password?" if you need to).`, "", "If this wasn't you, you can ignore this email.", "", "Cobra"].join("\n") });

export type SignupResult = { status: number; body: { ok?: true; message?: string; error?: string } };

/**
 * POST /api/auth/register {mode:"create"|"join"}. Validation errors are about the input only; past
 * that the response is the same whether or not the email or team exists. The per-IP limit is
 * checked by the route (429); the per-email limit and the caps here are silent.
 */
export async function requestSignup(db: DB, b: Record<string, unknown>, send: Send, now = Date.now()): Promise<SignupResult> {
  const mode = b.mode === "create" ? "create_team" : b.mode === "join" ? "join" : null;
  if (!mode) return { status: 400, body: { error: "mode must be create or join" } };
  const email = norm(b.email), name = clean(b.name, 100);
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: "Enter a valid email" } };
  if (!name) return { status: 400, body: { error: "Enter your name" } };
  let teamName = "", pw: string | null = null;
  if (mode === "create_team") {
    if (!signupsAllowed(db)) return { status: 403, body: { error: "New team sign-ups are turned off. Ask a team lead for an invite." } };
    teamName = clean(b.teamName, 60);
    if (teamName.length < 2) return { status: 400, body: { error: "Team name must be 2-60 characters" } };
    const password = typeof b.password === "string" ? b.password : "";
    if (password.length < MIN_PASSWORD) return { status: 400, body: { error: `Password must be at least ${MIN_PASSWORD} characters` } };
    pw = hashPassword(password);
  } else {
    teamName = clean(b.team, 80);
    if (!teamName) return { status: 400, body: { error: "Enter the team name or slug" } };
  }
  const message = mode === "create_team" ? GENERIC_CREATE : GENERIC_JOIN;
  const ok: SignupResult = { status: 200, body: { ok: true, message } };
  db.prepare("DELETE FROM signup_verifications WHERE expires_at <= ?").run(now - JOIN_TTL_MS);
  if (consume(db, LIMITS.registerEmail, emailKey(email), now).limited) return ok;
  if (userExists(db, email)) { const m = alreadyHaveAccount(); void mailSafe(send, email, m.subject, m.body); return ok; }
  const open = (db.prepare("SELECT count(*) n FROM signup_verifications WHERE email = ? AND used_at IS NULL AND expires_at > ?").get(email, now) as { n: number }).n;
  if (open >= MAX_OPEN_VERIFICATIONS_PER_EMAIL) return ok;
  const tok = token();
  db.prepare("INSERT INTO signup_verifications (kind, email, name, password_hash, team_name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(mode, email, name, pw, teamName, hash(tok), now, now + (mode === "create_team" ? CREATE_VERIFY_TTL_MS : JOIN_TTL_MS));
  const m = verifyEmail(mode, tok);
  void mailSafe(send, email, m.subject, m.body);
  return ok;
}

export const VERIFY_ERRORS = { invalid: "This confirmation link isn't valid or has expired. Start again from the sign-up page." } as const;

/** For the /register/confirm page (no side effects: mail scanners may GET the link). */
export function verificationKind(db: DB, tok: unknown, now = Date.now()): "create_team" | "join" | null {
  if (typeof tok !== "string" || !tok || tok.length > 200) return null;
  const r = db.prepare("SELECT kind FROM signup_verifications WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(hash(tok), now) as { kind: "create_team" | "join" } | undefined;
  return r?.kind ?? null;
}

export type ConfirmResult =
  | { ok: true; kind: "create_team"; userId: number; tenantId: number; slug: string }
  | { ok: true; kind: "join"; message: string }
  | { ok: false; status: number; error: string };

/** POST /api/auth/register/confirm {token}: single use. Create: team + lead account (caller signs in). Join: pending request. */
export async function confirmSignup(db: DB, tok: unknown, send: Send, now = Date.now()): Promise<ConfirmResult> {
  if (typeof tok !== "string" || !tok || tok.length > 200) return { ok: false, status: 400, error: VERIFY_ERRORS.invalid };
  db.exec("BEGIN IMMEDIATE");
  let notify: null | { tenantId: number; teamName: string; requestId: number; email: string; name: string } = null;
  let result: ConfirmResult;
  try {
    const v = db.prepare("SELECT id, kind, email, name, password_hash pw, team_name teamName FROM signup_verifications WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(hash(tok), now) as
      { id: number; kind: "create_team" | "join"; email: string; name: string; pw: string | null; teamName: string } | undefined;
    if (!v) { db.exec("ROLLBACK"); return { ok: false, status: 400, error: VERIFY_ERRORS.invalid }; }
    db.prepare("UPDATE signup_verifications SET used_at = ? WHERE id = ?").run(now, v.id);
    if (v.kind === "create_team") {
      if (!signupsAllowed(db)) { db.exec("COMMIT"); return { ok: false, status: 403, error: "New team sign-ups are turned off. Ask a team lead for an invite." }; }
      if (userExists(db, v.email) || !v.pw) { db.exec("COMMIT"); return { ok: false, status: 400, error: "This email already has an account. Sign in instead." }; }
      const slug = uniqueSlug(db, v.teamName);
      const tenantId = Number(db.prepare("INSERT INTO tenants (name, slug, created_at) VALUES (?, ?, ?)").run(v.teamName, slug, now).lastInsertRowid);
      const userId = Number(db.prepare("INSERT INTO users (tenant_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'team_lead', ?)").run(tenantId, v.email, v.name, v.pw, now).lastInsertRowid);
      db.prepare("UPDATE tenants SET designated_lead_user_id = ? WHERE id = ?").run(userId, tenantId);
      const me = { id: userId, email: v.email };
      audit(db, tenantId, me, "team_create", me, `team "${v.teamName}" (slug ${slug}) created by self-serve sign-up; email verified`, now);
      audit(db, tenantId, me, "designate", me, "team creator: team_lead + designated lead", now);
      db.prepare("UPDATE signup_verifications SET used_at = ? WHERE email = ? AND kind = 'create_team' AND used_at IS NULL").run(now, v.email);
      result = { ok: true, kind: "create_team", userId, tenantId, slug };
    } else {
      result = { ok: true, kind: "join", message: GENERIC_JOIN_CONFIRMED };
      const team = findTeam(db, v.teamName);
      if (team && !userExists(db, v.email)) {
        expireJoinRequests(db, now);
        const dupe = db.prepare("SELECT 1 FROM join_requests WHERE tenant_id = ? AND email = ? AND status IN ('pending','link_sent')").get(team.id, v.email);
        const perEmail = (db.prepare("SELECT count(*) n FROM join_requests WHERE email = ? AND status = 'pending'").get(v.email) as { n: number }).n;
        const perTeam = (db.prepare("SELECT count(*) n FROM join_requests WHERE tenant_id = ? AND status = 'pending'").get(team.id) as { n: number }).n;
        if (!dupe && perEmail < MAX_PENDING_PER_EMAIL && perTeam < MAX_PENDING_PER_TEAM) {
          const requestId = Number(db.prepare("INSERT INTO join_requests (tenant_id, email, name, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(team.id, v.email, v.name, now, now + JOIN_TTL_MS).lastInsertRowid);
          audit(db, team.id, { id: null, email: v.email }, "join_request", { email: v.email }, `join request #${requestId} (${v.name}); email verified`, now);
          notify = { tenantId: team.id, teamName: team.name, requestId, email: v.email, name: v.name };
        }
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  if (notify) await notifyLeads(db, notify, send, now);
  return result;
}

async function notifyLeads(db: DB, n: { tenantId: number; teamName: string; requestId: number; email: string; name: string }, send: Send, now: number) {
  const d = designatedLead(db, n.tenantId);
  const to = [...new Set([...(d ? [d.email] : []), ...teamLeads(db, n.tenantId).map((l) => l.email)])];
  const subject = `Join request for ${n.teamName} on Cobra`;
  const body = [`${n.name} <${n.email}> asked to join your team "${n.teamName}" on Cobra and confirmed their email.`, "", `Review it under Join requests on ${publicBase()}/settings/team: send them an invite link, or dismiss it.`, "", "Requests that aren't answered expire after 14 days.", "", "Cobra"].join("\n");
  const failed: string[] = [];
  for (const r of to) if (await mailSafe(send, r, subject, body)) failed.push(r);
  audit(db, n.tenantId, { id: null, email: "system" }, "join_notify", { email: n.email }, to.length ? `request #${n.requestId}: emailed ${to.length} lead(s)${failed.length ? `, ${failed.length} failed` : ""}` : `request #${n.requestId}: no team leads to email`, now);
}

// ---------- join requests on the Team page ----------
export type JoinRequestRow = { id: number; email: string; name: string; status: string; createdAt: number; expiresAt: number; decidedBy: string | null; decidedAt: number | null };

/** Pending requests past 14 days become expired (audited). */
export function expireJoinRequests(db: DB, now = Date.now()): number {
  const rows = db.prepare("SELECT id, tenant_id t, email FROM join_requests WHERE status = 'pending' AND expires_at <= ?").all(now) as Array<{ id: number; t: number; email: string }>;
  for (const r of rows) {
    db.prepare("UPDATE join_requests SET status = 'expired', decided_at = ? WHERE id = ?").run(now, r.id);
    audit(db, r.t, { id: null, email: "system" }, "join_expire", { email: r.email }, `join request #${r.id} unanswered for 14 days`, now);
  }
  return rows.length;
}

export function listJoinRequests(db: DB, tenantId: number, now = Date.now(), limit = 50): JoinRequestRow[] {
  expireJoinRequests(db, now);
  return db.prepare("SELECT id, email, name, status, created_at createdAt, expires_at expiresAt, decided_by decidedBy, decided_at decidedAt FROM join_requests WHERE tenant_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT ?").all(tenantId, limit) as JoinRequestRow[];
}

function pendingRequest(db: DB, u: RegActor, id: number, now: number) {
  canInvite(db, u);
  expireJoinRequests(db, now);
  const r = db.prepare("SELECT id, email, name, status FROM join_requests WHERE id = ? AND tenant_id = ?").get(id, u.tenantId) as { id: number; email: string; name: string; status: string } | undefined;
  if (!r) throw new CollabError(404, "no such join request on this team");
  if (r.status !== "pending" && r.status !== "link_sent") throw new CollabError(409, `this request is already ${r.status}`);
  return r;
}

/** Lead/admin: email a single-use member invite to the requester. Re-sending replaces the old link. */
export async function sendJoinLink(db: DB, u: RegActor, id: number, send: Send, now = Date.now()) {
  const r = pendingRequest(db, u, id, now);
  if (userExists(db, r.email)) throw new CollabError(409, "that email already has a Cobra account");
  if (consume(db, LIMITS.inviteUser, `u${u.id}`, now).limited) throw new CollabError(429, "too many invites sent; try again later");
  const team = (db.prepare("SELECT name FROM tenants WHERE id = ?").get(u.tenantId) as { name: string }).name;
  const inv = issueInvite(db, u, r.email, "member", r.id, now);
  db.prepare("UPDATE join_requests SET status = 'link_sent', decided_by = ?, decided_at = ? WHERE id = ?").run(u.email, now, r.id);
  audit(db, u.tenantId, u, "join_send_link", { email: r.email }, `join request #${r.id}: invite #${inv.id} sent`, now);
  const m = inviteEmail(team, u.email, inv.token);
  return { mailError: await mailSafe(send, r.email, m.subject, m.body) };
}

export function dismissJoinRequest(db: DB, u: RegActor, id: number, now = Date.now()) {
  const r = pendingRequest(db, u, id, now);
  db.prepare("UPDATE join_requests SET status = 'dismissed', decided_by = ?, decided_at = ? WHERE id = ?").run(u.email, now, r.id);
  db.prepare("UPDATE team_invites SET revoked_at = ? WHERE join_request_id = ? AND used_at IS NULL AND revoked_at IS NULL").run(now, r.id);
  audit(db, u.tenantId, u, "join_dismiss", { email: r.email }, `join request #${r.id}`, now);
}
