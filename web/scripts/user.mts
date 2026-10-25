// Admin CLI for accounts (there is no public sign-up).
//   npm run user:create -- --email x@y.com --tenant default --role admin|team_lead|member [--name "Full Name"] [--tenant-name "Team"]
//   npm run user:reset-password -- --email x@y.com
// The password comes from COBRA_USER_PASSWORD or stdin, never from arguments, and is never logged.
import { parseArgs } from "node:util";
import { dbPath, openDb } from "../lib/db";
import { createUser, resetPassword } from "../lib/auth/users";

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: "string" }, tenant: { type: "string" }, role: { type: "string" }, name: { type: "string" }, "tenant-name": { type: "string" } },
});

async function password(): Promise<string> {
  if (process.env.COBRA_USER_PASSWORD) return process.env.COBRA_USER_PASSWORD;
  if (process.stdin.isTTY) process.stderr.write("Pipe the password on stdin or set COBRA_USER_PASSWORD.\n");
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

try {
  if (!values.email) throw new Error("--email is required");
  const db = openDb(dbPath());
  if (cmd === "create") {
    if (!values.tenant || !values.role) throw new Error("--tenant and --role are required");
    createUser(db, { email: values.email, tenant: values.tenant, role: values.role as "admin" | "team_lead" | "member", name: values.name, tenantName: values["tenant-name"], password: await password() });
    console.log(`Created ${values.email.toLowerCase()} (${values.role}) in tenant '${values.tenant}'`);
  } else if (cmd === "reset-password") {
    resetPassword(db, values.email, await password());
    console.log(`Password reset for ${values.email.toLowerCase()}; existing sessions signed out`);
  } else throw new Error("usage: user.mts create|reset-password --email ...");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
