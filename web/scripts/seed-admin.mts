// Creates/updates the default tenant ('Vic', slug default) and admin user vic.
// Password from COBRA_ADMIN_PASSWORD or stdin; never from argv, never logged.
import { openDb, dbPath } from "../lib/db";
import { seedAdmin } from "../lib/auth/users";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Password (input hidden is not supported; pipe it in): ");
  }
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

const password = process.env.COBRA_ADMIN_PASSWORD || (await readStdin());
if (password.length < 8) {
  console.error("Password must be at least 8 characters");
  process.exit(1);
}
const db = openDb(dbPath());
const result = seedAdmin(db, {
  username: process.env.COBRA_ADMIN_USERNAME || "vic",
  email: process.env.COBRA_ADMIN_EMAIL || "vicgupta@gmail.com",
  name: process.env.COBRA_ADMIN_NAME || "Vic Gupta",
  password,
});
console.log(`Admin user ${result} in tenant 'default' (${dbPath()})`);
