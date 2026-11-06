// Pure constants + the run prompt note for the team email (no DB imports, so the runner can use it).
export const KANTSY_API = "https://api.kantsy.com";
export const TEAM_EMAIL_ENV = "COBRA_TEAM_EMAIL", TEAM_EMAIL_TOKEN_ENV = "COBRA_TEAM_EMAIL_TOKEN";

/** Prompt note for runs that get the team email. */
export const teamEmailNote = (address: string) =>
  `\n\n[Cobra] This team's email is ${address} (in $${TEAM_EMAIL_ENV}). Use it only if the task needs email. API: ${KANTSY_API} with header "Authorization: Bearer $${TEAM_EMAIL_TOKEN_ENV}". `
  + `Send: POST /email with JSON {"to": "<one address>", "subject": "...", "body": "plain text"} (60 sends/hour). Read: GET /email?direction=in&unread=true, then GET /email/<id>. `
  + `Never print, log, commit or echo the token; reference the env var only.`;
