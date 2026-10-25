// AES-256-GCM for small secrets stored in the DB (per-repo GitHub PATs).
// Key: COBRA_SECRET_KEY in the server env file, 32 random bytes as base64 or hex. Never logged.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SecretKeyError extends Error {}

export function parseKey(raw: string | undefined): Buffer {
  const v = (raw ?? "").trim();
  if (!v) throw new SecretKeyError("COBRA_SECRET_KEY is not set in the server env file, so tokens can't be saved");
  const k = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (k.length !== 32) throw new SecretKeyError("COBRA_SECRET_KEY must be 32 bytes (base64 or hex)");
  return k;
}

/** "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plain: string, rawKey: string | undefined): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", parseKey(rawKey), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decryptSecret(enc: string, rawKey: string | undefined): string {
  const [v, iv, tag, ct] = enc.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new SecretKeyError("unrecognized encrypted value");
  const d = createDecipheriv("aes-256-gcm", parseKey(rawKey), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
