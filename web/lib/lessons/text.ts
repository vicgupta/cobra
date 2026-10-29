// Lesson text hygiene: every stored field goes through clean() (value redaction + credential patterns,
// log-dump stripping, whitespace normalisation, hard length caps) so lessons stay short and secret-free.
import { redact } from "../workflows/engine";
import { maskSecrets } from "../admin-changes";

export const CAPS = { title: 100, what_happened: 200, what_we_learned: 200, evidence: 400, tag: 32, tags: 10, feedback: 1000, reason: 200, repo: 140 } as const;

/** Email addresses and phone-ish numbers (PII) in lesson text. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const KV = /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS))\s*[=:]\s*\S+/g;

/** Redacts known secret values plus credential-looking patterns (shared with the admin digest's maskSecrets). */
export function scrub(text: string, secrets: Iterable<string> = []): string {
  return maskSecrets(redact(text, secrets).replace(PEM, "[redacted]").replace(KV, "$1=[redacted]"));
}

/** True when text still looks like it carries a secret or PII (sanitization pass flag). */
export function looksSensitive(text: string): boolean {
  const t = text.replace(/\[redacted\]|\[REDACTED\]/gi, "");
  return /\b(?:sk|ghp|gho|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{6,}/.test(t) || /[A-Za-z0-9+/_=-]{32,}/.test(t) || PEM.test(t) || new RegExp(EMAIL.source).test(t) || new RegExp(PHONE.source).test(t) || new RegExp(KV.source).test(t);
}

/** Strips log boilerplate: ANSI codes, [stdout]-style headers, timestamps, stack frames, blank runs. */
export function stripLog(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[(stdout|stderr|log|summary|agent)\][^\n]*$/i, "").replace(/^\s*\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s*/, "").trim())
    .filter((l) => l && !/^at .+\(.+:\d+:\d+\)$/.test(l) && !/^at [\w.<>]+ \(/.test(l))
    .join(" ");
}

/** One compact line: scrubbed, log-stripped, whitespace collapsed, capped at max chars (ellipsis). */
export function clean(text: unknown, max: number, secrets: Iterable<string> = []): string {
  const s = scrub(stripLog(typeof text === "string" ? text : ""), secrets).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function cleanTags(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const t of raw) {
    const s = String(t).toLowerCase().replace(/[^a-z0-9._/-]/g, "").slice(0, CAPS.tag);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= CAPS.tags) break;
  }
  return out;
}

const STOP = new Set("the a an and or to of in on for with is are was were be by at from this that it as run runs step agent skill task cobra".split(" "));
/** Lower-case keywords (3+ chars, no stop words) for matching. */
export function keywords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

export const confidenceLabel = (c: number) => (c >= 0.7 ? "high" : c >= 0.4 ? "medium" : "low");
export function parseConfidence(v: unknown): number | null {
  if (v === "low") return 0.3; if (v === "medium") return 0.55; if (v === "high") return 0.85;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
