// Failed-login limits: per IP and per account (sha256 of the email). A
// successful login clears that account's counter (not the IP's).
import type { DB } from "../db";
import { clearLimit, emailKey, hit, LIMITS, peek, type LimitState } from "./rate-limit";

/** The most restrictive limited state for this IP/account, or null when allowed. */
export function loginBlocked(db: DB, ip: string, email: string, now = Date.now()): LimitState | null {
  const s = [peek(db, LIMITS.loginIp, ip, now), peek(db, LIMITS.loginAccount, emailKey(email), now)].filter((x) => x.limited);
  return s.length ? s.reduce((a, b) => (a.retryAfterSec >= b.retryAfterSec ? a : b)) : null;
}
export function recordLoginFailure(db: DB, ip: string, email: string, now = Date.now()): void {
  hit(db, LIMITS.loginIp, ip, now, false);
  hit(db, LIMITS.loginAccount, emailKey(email), now, false);
}
export function recordLoginSuccess(db: DB, email: string): void {
  clearLimit(db, LIMITS.loginAccount, emailKey(email));
}
