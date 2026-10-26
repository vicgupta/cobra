// Job 3: self-serve registration (lib/registration.ts) with a mock mailer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../lib/db";
import { createUser } from "../lib/auth/users";
import { verifyPassword } from "../lib/auth/password";
import { CollabError, designatedLead } from "../lib/collab";
import * as R from "../lib/registration";

type Mail = { to: string; subject: string; body: string };
function setup() {
  const db = openDb(":memory:");
  const mk = (email: string, role: "admin" | "team_lead" | "member", tenant: string) => {
    const id = createUser(db, { email, tenant, tenantName: tenant === "team-a" ? "Team A" : tenant, role, password: "pw-1234567890" });
    const t = (db.prepare("SELECT tenant_id t FROM users WHERE id = ?").get(id) as { t: number }).t;
    return { id, email, role, tenantId: t };
  };
  const root = mk("root@a.com", "admin", "team-a");
  const lead = mk("lead@a.com", "team_lead", "team-a"), member = mk("member@a.com", "member", "team-a"), other = mk("lead@b.com", "team_lead", "team-b");
  const outbox: Mail[] = [];
  const send: R.Send = async (to, subject, body) => { outbox.push({ to, subject, body }); };
  return { db, root, lead, member, other, outbox, send };
}
const st = (n: number) => (e: unknown) => e instanceof CollabError && e.status === n;
const tok = (m: Mail, re: RegExp) => (m.body.match(re) ?? [])[1];
const audit = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT action FROM team_audit ORDER BY id").all() as Array<{ action: string }>).map((r) => r.action);
const tick = () => new Promise((r) => setImmediate(r));

test("invites: lead invites member; single use, email-bound, hashed; accept creates member", async () => {
  const { db, lead, outbox, send } = setup();
  const r = await R.createInvite(db, lead, { email: "New@X.com" }, send);
  assert.equal(r.role, "member"); assert.equal(r.email, "new@x.com");
  const t = tok(outbox[0], /invite=([\w-]+)/);
  assert.ok(t);
  assert.ok(!(db.prepare("SELECT token_hash h FROM team_invites").get() as { h: string }).h.includes(t));
  const c = R.checkInvite(db, t); assert.ok(c.ok && c.teamName === "Team A" && c.email === "new@x.com");
  assert.equal(R.acceptInvite(db, t, { name: "N", password: "short" }).ok, false);
  const a = R.acceptInvite(db, t, { name: "New Person", password: "long-password-1" });
  assert.ok(a.ok);
  const u = db.prepare("SELECT email, role, tenant_id t, password_hash p FROM users WHERE id = ?").get(a.userId) as { email: string; role: string; t: number; p: string };
  assert.deepEqual([u.email, u.role, u.t], ["new@x.com", "member", lead.tenantId]);
  assert.ok(verifyPassword("long-password-1", u.p));
  const again = R.acceptInvite(db, t, { name: "X", password: "long-password-1" });
  assert.ok(!again.ok && again.error === R.INVITE_ERRORS.used);
  assert.deepEqual(audit(db), ["invite_create", "invite_accept"]);
});

test("invites: roles, permissions, expiry, revoke, existing account", async () => {
  const { db, root, lead, member, outbox, send } = setup();
  await assert.rejects(R.createInvite(db, member, { email: "a@x.com" }, send), st(403));
  await assert.rejects(R.createInvite(db, lead, { email: "a@x.com", role: "team_lead" }, send), st(403));
  await assert.rejects(R.createInvite(db, lead, { email: "member@a.com" }, send), st(409));
  await assert.rejects(R.createInvite(db, lead, { email: "bad" }, send), st(400));
  assert.equal((await R.createInvite(db, root, { email: "tl@x.com", role: "team_lead" }, send)).role, "team_lead");
  const now = Date.now();
  await R.createInvite(db, lead, { email: "e@x.com" }, send, now);
  const t = tok(outbox.at(-1)!, /invite=([\w-]+)/);
  const late = R.checkInvite(db, t, now + R.INVITE_TTL_MS + 1); assert.ok(!late.ok && late.error === R.INVITE_ERRORS.expired);
  const id = R.listInvites(db, lead.tenantId).find((i) => i.email === "e@x.com")!.id;
  assert.throws(() => R.revokeInvite(db, member, id), st(403));
  R.revokeInvite(db, lead, id);
  const rv = R.checkInvite(db, t); assert.ok(!rv.ok && rv.error === R.INVITE_ERRORS.revoked);
  assert.equal(R.listInvites(db, lead.tenantId).find((i) => i.id === id)!.status, "revoked");
  assert.ok(!R.checkInvite(db, "nope").ok);
  assert.ok(audit(db).includes("invite_revoke"));
});

test("create team: verify-first, creator is team_lead + designated lead (not admin), unique slug, toggle", async () => {
  const { db, root, member, outbox, send } = setup();
  const n0 = (db.prepare("SELECT count(*) n FROM users").get() as { n: number }).n;
  const r = await R.requestSignup(db, { mode: "create", email: "f@x.com", name: "Founder", password: "long-password-1", teamName: "Team A" }, send);
  await tick();
  assert.equal(r.body.message, R.GENERIC_CREATE);
  assert.equal((db.prepare("SELECT count(*) n FROM users").get() as { n: number }).n, n0);
  const t = tok(outbox.at(-1)!, /token=([\w-]+)/);
  assert.equal(R.verificationKind(db, t), "create_team");
  const c = await R.confirmSignup(db, t, send);
  assert.ok(c.ok && c.kind === "create_team");
  assert.equal(c.slug, "team-a-2");
  const u = db.prepare("SELECT role, tenant_id t FROM users WHERE id = ?").get(c.userId) as { role: string; t: number };
  assert.equal(u.role, "team_lead"); assert.equal(u.t, c.tenantId);
  assert.equal(designatedLead(db, c.tenantId)?.id, c.userId);
  assert.ok(!(await R.confirmSignup(db, t, send)).ok);
  // toggle (admin only, audited); off blocks create
  assert.throws(() => R.setSignupsAllowed(db, member, false), st(403));
  R.setSignupsAllowed(db, root, false);
  assert.equal((await R.requestSignup(db, { mode: "create", email: "g@x.com", name: "G", password: "long-password-1", teamName: "G" }, send)).status, 403);
  assert.ok(audit(db).includes("team_create") && audit(db).includes("signup_toggle"));
  assert.equal(R.uniqueSlug(db, "Default"), "default-2");
});

test("no enumeration: existing email and unknown team get the same generic response", async () => {
  const { db, outbox, send } = setup();
  const a = await R.requestSignup(db, { mode: "join", email: "member@a.com", name: "M", team: "team-a" }, send);
  const b = await R.requestSignup(db, { mode: "join", email: "q@x.com", name: "Q", team: "no-such-team" }, send);
  await tick();
  assert.deepEqual(a, b);
  assert.match(outbox[0].subject, /already have/);
  const c = await R.confirmSignup(db, tok(outbox[1], /token=([\w-]+)/), send);
  assert.ok(c.ok && c.kind === "join" && c.message === R.GENERIC_JOIN_CONFIRMED);
  assert.equal((db.prepare("SELECT count(*) n FROM join_requests").get() as { n: number }).n, 0);
});

test("join: pending request, leads notified, send link -> accept; dismiss; expiry; caps", async () => {
  const { db, lead, member, other, outbox, send } = setup();
  await R.requestSignup(db, { mode: "join", email: "j@x.com", name: "Joiner", team: "team a" }, send); await tick();
  const c = await R.confirmSignup(db, tok(outbox.at(-1)!, /token=([\w-]+)/), send);
  assert.ok(c.ok && c.kind === "join");
  assert.ok(outbox.some((m) => m.to === "lead@a.com" && /Join request/.test(m.subject)));
  assert.ok(!outbox.some((m) => m.to === "lead@b.com"));
  const [req] = R.listJoinRequests(db, lead.tenantId);
  assert.equal(req.status, "pending");
  assert.equal(R.listJoinRequests(db, other.tenantId).length, 0);
  await assert.rejects(R.sendJoinLink(db, member, req.id, send), st(403));
  await assert.rejects(R.sendJoinLink(db, other, req.id, send), st(404));
  await R.sendJoinLink(db, lead, req.id, send);
  const t = tok(outbox.at(-1)!, /invite=([\w-]+)/);
  const a = R.acceptInvite(db, t, { name: "Joiner", password: "long-password-1" });
  assert.ok(a.ok);
  assert.equal(R.listJoinRequests(db, lead.tenantId)[0].status, "accepted");
  assert.deepEqual(audit(db).filter((x) => x.startsWith("join") || x.startsWith("invite")), ["join_request", "join_notify", "invite_create", "join_send_link", "invite_accept"]);
  // dismiss + expire
  const now = Date.now();
  for (const e of ["d@x.com", "e@x.com"]) { await R.requestSignup(db, { mode: "join", email: e, name: e, team: "team-a" }, send, now); await tick(); await R.confirmSignup(db, tok(outbox.at(-1)!, /token=([\w-]+)/), send, now); }
  const d = R.listJoinRequests(db, lead.tenantId, now).find((r) => r.email === "d@x.com")!;
  R.dismissJoinRequest(db, lead, d.id, now);
  assert.throws(() => R.dismissJoinRequest(db, lead, d.id, now), st(409));
  const later = R.listJoinRequests(db, lead.tenantId, now + R.JOIN_TTL_MS + 1);
  assert.equal(later.find((r) => r.email === "e@x.com")!.status, "expired");
  assert.ok(audit(db).includes("join_dismiss") && audit(db).includes("join_expire"));
  // duplicate pending request for the same team is ignored
  await R.requestSignup(db, { mode: "join", email: "z@x.com", name: "z", team: "team-a" }, send); await tick();
  await R.requestSignup(db, { mode: "join", email: "z@x.com", name: "z", team: "team-a" }, send); await tick();
  const toks = outbox.filter((m) => m.to === "z@x.com").map((m) => tok(m, /token=([\w-]+)/));
  for (const x of toks) await R.confirmSignup(db, x, send);
  assert.equal(R.listJoinRequests(db, lead.tenantId).filter((r) => r.email === "z@x.com").length, 1);
});

test("per-email verification limit is silent; user 1 untouched", async () => {
  const { db, root, outbox, send } = setup();
  for (let i = 0; i < 6; i++) {
    const r = await R.requestSignup(db, { mode: "join", email: "spam@x.com", name: "s", team: "team-a" }, send);
    assert.equal(r.status, 200);
  }
  await tick();
  assert.equal(outbox.filter((m) => m.to === "spam@x.com").length, 3);
  assert.equal(root.id, 1);
  assert.equal((db.prepare("SELECT role FROM users WHERE id = 1").get() as { role: string }).role, "admin");
});
