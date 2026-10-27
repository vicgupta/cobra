// Loaded before every test file (npm test: --import). Tests must never read the real server env
// (/etc/cobra/cobra.env or prod process vars such as COBRA_ADMIN_EMAIL, COBRA_MAIL_FROM,
// COBRA_DIGEST_FROM, COBRA_GITHUB_ALLOWED_REPOS, tokens). Tests that need a value set their own.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const k of Object.keys(process.env)) if (/^(COBRA_|KANTSY_)/.test(k) || k === "GITHUB_TOKEN") delete process.env[k];
process.env.COBRA_ENV_FILE = path.join(mkdtempSync(path.join(tmpdir(), "cobra-test-env-")), "missing.env");
