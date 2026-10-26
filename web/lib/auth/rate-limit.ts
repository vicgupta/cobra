// DB-backed rate limits (rate_limits table, migration 6) so limits survive restarts.
// Fixed window per (bucket, key): the window starts at the first counted event
// and lasts `windowMs`. Updates run in a single IMMEDIATE transaction.
import { createHash } from "node:crypto";
import type { DB } from "../db";

export type Limit = { bucket: string; max: number; windowMs: number };
export type LimitState = { limited: boolean; count: number; retryAfterSec: number };

const M15 = 15 * 60 * 1000;
export const LIMITS = {
  loginIp: { bucket: "login-ip", max: 10, windowMs: M15 }, // failed logins per IP
  loginAccount: { bucket: "login-acct", max: 10, windowMs: M15 }, // failed logins per account
  forgotIp: { bucket: "forgot-ip", max: 10, windowMs: M15 }, // reset requests per IP (429)
  forgotEmail: { bucket: "forgot-email", max: 3, windowMs: M15 }, // reset requests per email (silent)
  resetIp: { bucket: "reset-ip", max: 20, windowMs: M15 }, // reset submissions per IP
  registerIp: { bucket: "register-ip", max: 10, windowMs: M15 }, // sign-up / join / invite-accept submissions per IP (429)
  registerEmail: { bucket: "register-email", max: 3, windowMs: M15 }, // verification emails per address (silent)
  confirmIp: { bucket: "confirm-ip", max: 20, windowMs: M15 }, // email-verification confirmations per IP (429)
  inviteUser: { bucket: "invite-user", max: 30, windowMs: 60 * 60 * 1000 }, // invites / magic links sent per lead or admin (429)
} satisfies Record<string, Limit>;

/** sha256 key for emails (normalized), so raw emails are never stored. */
export const emailKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

const CLEANUP_EVERY_MS = 60 * 1000;
const lastCleanup = new WeakMap<DB, number>();

/** Deletes expired rows; runs at most once a minute per DB handle unless forced. */
export function cleanupRateLimits(db: DB, now = Date.now(), force = false): number {
  if (!force && now - (lastCleanup.get(db) ?? 0) < CLEANUP_EVERY_MS) return 0;
  lastCleanup.set(db, now);
  return Number(db.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").run(now).changes);
}

function state(count: number, expiresAt: number, max: number, now: number): LimitState {
  const limited = count >= max;
  return { limited, count, retryAfterSec: limited ? Math.max(1, Math.ceil((expiresAt - now) / 1000)) : 0 };
}

/** Current state without counting. */
export function peek(db: DB, l: Limit, key: string, now = Date.now()): LimitState {
  const r = db.prepare("SELECT count, expires_at FROM rate_limits WHERE bucket = ? AND key = ?").get(l.bucket, key) as
    { count: number; expires_at: number } | undefined;
  if (!r || r.expires_at <= now) return state(0, now + l.windowMs, l.max, now);
  return state(r.count, r.expires_at, l.max, now);
}

/**
 * Counts one event atomically. With `onlyIfAllowed`, an event is not counted
 * once the key is already limited. Returns the state before this event was
 * added when it was refused, otherwise after.
 */
export function hit(db: DB, l: Limit, key: string, now = Date.now(), onlyIfAllowed = true): LimitState {
  cleanupRateLimits(db, now);
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = db.prepare("SELECT count, expires_at FROM rate_limits WHERE bucket = ? AND key = ?").get(l.bucket, key) as
      { count: number; expires_at: number } | undefined;
    let out: LimitState;
    if (!r || r.expires_at <= now) {
      db.prepare(`INSERT INTO rate_limits (bucket, key, count, window_start, expires_at) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT (bucket, key) DO UPDATE SET count = 1, window_start = excluded.window_start, expires_at = excluded.expires_at`)
        .run(l.bucket, key, now, now + l.windowMs);
      out = state(1, now + l.windowMs, l.max + 1, now);
    } else if (onlyIfAllowed && r.count >= l.max) {
      out = state(r.count, r.expires_at, l.max, now);
    } else {
      db.prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket = ? AND key = ?").run(l.bucket, key);
      out = state(r.count + 1, r.expires_at, l.max + 1, now);
    }
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Takes one slot: true (and nothing counted) when already at the limit. */
export function consume(db: DB, l: Limit, key: string, now = Date.now()): LimitState {
  return hit(db, l, key, now, true);
}

export function clearLimit(db: DB, l: Limit, key: string): void {
  db.prepare("DELETE FROM rate_limits WHERE bucket = ? AND key = ?").run(l.bucket, key);
}
