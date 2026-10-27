// Sender for every system email (password resets, sign-up verification, invites, magic links,
// join links, daily notifications). COBRA_MAIL_FROM in the server env file overrides it.
export const DEFAULT_MAIL_FROM = "danny@kantsy.com";
export const mailFrom = (get: (key: string) => string | undefined) => (get("COBRA_MAIL_FROM") || "").trim() || DEFAULT_MAIL_FROM;

// Sender for the analytics digests only (system-admin all-teams digest and per-team digests, including
// their test sends). COBRA_DIGEST_FROM overrides it; COBRA_MAIL_FROM and other system mail are unaffected.
export const DEFAULT_DIGEST_FROM = "cobra@kantsy.com";
export const digestFrom = (get: (key: string) => string | undefined) => (get("COBRA_DIGEST_FROM") || "").trim() || DEFAULT_DIGEST_FROM;
/** The From address for a send: "digest" uses digestFrom, anything else mailFrom. */
export const senderFor = (get: (key: string) => string | undefined, sender?: "digest") => (sender === "digest" ? digestFrom(get) : mailFrom(get));
