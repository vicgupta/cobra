// One-off: clear agent fields and "run" header events from runs of workflows with no agent step.
// Usage: npm run runs:cleanup-non-agent [-- --dry-run]
import { dbPath, openDb } from "../lib/db";
import { cleanupNonAgentRuns } from "../lib/workflows/cleanup";

const dryRun = process.argv.includes("--dry-run");
const db = openDb(dbPath());
db.exec("BEGIN");
try {
  const items = cleanupNonAgentRuns(db, { dryRun });
  db.exec(dryRun ? "ROLLBACK" : "COMMIT");
  for (const i of items) console.log(`${dryRun ? "would fix" : "fixed"} ${i.id} (${i.workflow}) header events: ${i.headerEvents}${i.clearedLegacy ? ", legacy repo/agent/prompt cleared" : ""}`);
  console.log(`${items.length} run(s) ${dryRun ? "to fix" : "fixed"}`);
} catch (e) { db.exec("ROLLBACK"); throw e; }
