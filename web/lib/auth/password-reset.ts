// Password reset by email. A 32-byte random token is emailed; only its sha256
// is stored. Tokens last 30 minutes and are single-use.
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "../db";
import { hashPassword } from "./password";
import { MIN_PASSWORD } from "./users";
import { consume, emailKey, LIMITS } from "./rate-limit";

export const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_URL_BASE = "https://nova.kantsy.com/reset-password";
export const GENERIC_RESET_MESSAGE = "If an account exists for that email, we've sent a link to reset your password. It expires in 30 minutes.";

export const hashResetToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Creates a reset token for the email's user, or returns null when no such user exists. */
export function createResetToken(db: DB, email: string, now = Date.now()): { token: string; userId: number; email: string } | null {
  const u = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email.trim().toLowerCase()) as { id: number; email: string } | undefined;
  if (!u) return null;
  const token = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM password_resets WHERE expires_at <= ? OR used_at IS NOT NULL").run(now - 24 * 60 * 60 * 1000);
  db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(u.id, hashResetToken(token), now + RESET_TTL_MS, now);
  return { token, userId: u.id, email: u.email };
}

export type TokenState = "valid" | "expired" | "used" | "unknown";

export function resetTokenState(db: DB, token: string | undefined, now = Date.now()): TokenState {
  if (!token) return "unknown";
  const r = db.prepare("SELECT expires_at, used_at FROM password_resets WHERE token_hash = ?").get(hashResetToken(token)) as
    { expires_at: number; used_at: number | null } | undefined;
  if (!r) return "unknown";
  if (r.used_at !== null) return "used";
  if (r.expires_at <= now) return "expired";
  return "valid";
}

export const TOKEN_ERRORS: Record<Exclude<TokenState, "valid">, string> = {
  expired: "This reset link has expired. Request a new one.",
  used: "This reset link has already been used. Request a new one if you still need it.",
  unknown: "This reset link is not valid. Request a new one.",
};

/**
 * Sets a new password with a valid token: marks it used, invalidates the user's
 * other outstanding tokens, and ends all the user's sessions. Atomic.
 */
export function resetWithToken(db: DB, token: string, password: string, now = Date.now()):
  { ok: true; userId: number } | { ok: false; error: string } {
  if (password.length < MIN_PASSWORD) return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters` };
  const state = resetTokenState(db, token, now);
  if (state !== "valid") return { ok: false, error: TOKEN_ERRORS[state] };
  const hash = hashPassword(password);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .get(hashResetToken(token), now) as { id: number; user_id: number } | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, error: TOKEN_ERRORS.used };
    }
    db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(now, row.id);
    db.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(now, row.user_id);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, row.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    db.exec("COMMIT");
    return { ok: true, userId: row.user_id };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Plain-text reset email. */
export function resetEmail(token: string): { subject: string; body: string } {
  return {
    subject: "Reset your Cobra password",
    body: [
      "Someone (hopefully you) asked to reset the password for your Cobra account.",
      "",
      "To choose a new password, open this link:",
      `${RESET_URL_BASE}?token=${token}`,
      "",
      "The link works once and expires in 30 minutes. Resetting your password signs you out everywhere.",
      "",
      "If you didn't ask for this, you can ignore this email; your password won't change.",
      "",
      "Cobra",
    ].join("\n"),
  };
}

/**
 * Handles a reset request for an email: throttled per email (silently), token
 * created and email sent (not awaited) only when the user exists. Always
 * returns the same generic message.
 */
export function requestReset(db: DB, email: string, send: (to: string, subject: string, body: string) => Promise<void>, now = Date.now()): string {
  const e = email.trim().toLowerCase();
  if (!consume(db, LIMITS.forgotEmail, emailKey(e), now).limited) {
    const t = createResetToken(db, e, now);
    if (t) {
      const { subject, body } = resetEmail(t.token);
      send(t.email, subject, body).catch((err) => console.error("password reset email:", err instanceof Error ? err.message : err));
    }
  }
  return GENERIC_RESET_MESSAGE;
}
