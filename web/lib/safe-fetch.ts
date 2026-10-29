// Shared SSRF guard for server-side requests to user-supplied URLs (custom provider "Test connection",
// skill/agent "Import from URL"). The host must resolve to public addresses only (no loopback / private /
// link-local / multicast). COBRA_CP_TEST_ALLOW_HOSTS (comma-separated host[:port]) skips the address check
// for those hosts; it is meant for local previews against a mock server and is not set in production.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type GuardDeps = { lookup?: (host: string) => Promise<string[]>; allowHosts?: string[] };

export const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** True for addresses a server-side request must never reach. */
export function isBlockedAddress(ip: string): boolean {
  let a = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1];
  if (isIP(a) === 4) {
    const [p, q] = a.split(".").map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (isIP(a) === 6) return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("::ffff:") || a.startsWith("64:ff9b:");
  return true;
}

export const envAllowHosts = () => (process.env.COBRA_CP_TEST_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export class BlockedHostError extends Error { constructor(msg: string) { super(msg); } }

/** Throws BlockedHostError(`blockedMsg` or "could not resolve <host>") unless the URL's host is public (or allow-listed). */
export async function guardPublicHost(u: URL, deps: GuardDeps, blockedMsg: string): Promise<void> {
  const allow = deps.allowHosts ?? envAllowHosts();
  if (allow.includes(u.host.toLowerCase()) || allow.includes(u.hostname.toLowerCase())) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new BlockedHostError(blockedMsg);
  let addrs: string[];
  try { addrs = isIP(host) ? [host] : await (deps.lookup ?? defaultLookup)(host); } catch { throw new BlockedHostError(`could not resolve ${host}`); }
  if (!addrs.length || addrs.some(isBlockedAddress)) throw new BlockedHostError(blockedMsg);
}
