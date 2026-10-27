// Sender for every system email (password resets, sign-up verification, invites, magic links,
// join links, daily notifications). COBRA_MAIL_FROM in the server env file overrides it.
export const DEFAULT_MAIL_FROM = "danny@kantsy.com";
export const mailFrom = (get: (key: string) => string | undefined) => (get("COBRA_MAIL_FROM") || "").trim() || DEFAULT_MAIL_FROM;
