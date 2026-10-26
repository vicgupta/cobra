// Outbound email via the Kantsy API. Credentials are read fresh from the server
// env file each send (falling back to the process env), and never logged.
import "server-only";
import { appendFileSync, readFileSync } from "node:fs";
import { envFilePath, parseEnv } from "./env-file";

function secret(key: string): string | undefined {
  try {
    const v = parseEnv(readFileSync(envFilePath(), "utf8"))[key];
    if (v) return v;
  } catch {
    // No env file: use the process env.
  }
  return process.env[key] || undefined;
}

export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  // Local/throwaway testing only: COBRA_MAIL_OUTBOX=<file> appends each message as a JSON line
  // instead of sending (never set on the production service).
  const outbox = process.env.COBRA_MAIL_OUTBOX;
  if (outbox) { appendFileSync(outbox, JSON.stringify({ to, subject, body, at: Date.now() }) + "\n", { mode: 0o600 }); return; }
  const base = secret("KANTSY_API_BASE"), token = secret("KANTSY_API_TOKEN");
  if (!base || !token) throw new Error("Email is not configured (KANTSY_API_BASE / KANTSY_API_TOKEN)");
  const r = await fetch(`${base.replace(/\/$/, "")}/email`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ to, subject, body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Email send failed: HTTP ${r.status}`);
}
