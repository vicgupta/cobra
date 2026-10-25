// Workflow CLI.
//   npm run workflow:list
//   npm run workflow:validate [-- --file path.yaml]
//   npm run workflow:approve -- --name test-run --email lead@x.com [--comment "..."]
//   npm run workflow:reject  -- --name test-run --email lead@x.com [--comment "..."]
//   npm run workflow:schema      (regenerates workflows/workflow.schema.json)
// Approve/reject act as the given user (CLI access to the server = trust); the
// same permission rules as the web UI apply.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { dbPath, openDb } from "../lib/db";
import { approvalState, recordDecision, type Approver } from "../lib/workflows/approvals";
import { getWorkflow, loadWorkflows, parseWorkflow, workflowsDir, WorkflowError } from "../lib/workflows/loader";
import { workflowJsonSchema } from "../lib/workflows/schema";

const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { name: { type: "string" }, email: { type: "string" }, comment: { type: "string" }, file: { type: "string" }, tenant: { type: "string" } } });

try {
  if (cmd === "schema") {
    const out = path.join(workflowsDir(), "workflow.schema.json");
    writeFileSync(out, JSON.stringify(workflowJsonSchema(), null, 2) + "\n");
    console.log(`Wrote ${out}`);
  } else if (cmd === "validate") {
    if (values.file) { parseWorkflow(readFileSync(values.file, "utf8"), values.file); console.log(`ok ${values.file}`); }
    else {
      const { workflows, errors } = loadWorkflows();
      for (const w of workflows) console.log(`ok   ${path.basename(w.file)}  ${w.workflow.name}@${w.workflow.version}  sha256:${w.hash.slice(0, 12)}`);
      for (const e of errors) console.error(`FAIL ${e.file}\n  - ${e.errors.join("\n  - ")}`);
      if (errors.length) process.exit(1);
    }
  } else if (cmd === "list") {
    const db = openDb(dbPath());
    const tenant = db.prepare("SELECT id FROM tenants WHERE slug = ?").get(values.tenant ?? "default") as { id: number } | undefined;
    const { workflows, errors } = loadWorkflows();
    for (const w of workflows) {
      const st = tenant ? approvalState(db, tenant.id, w) : null;
      const appr = w.workflow.governance.approvers.map((a) => (typeof a === "string" ? a : `role:${a.role}`)).join(", ");
      console.log(`${w.workflow.name}@${w.workflow.version}  owner=${w.workflow.governance.owner}  approvers=[${appr}]  status=${st?.status ?? "n/a"} (${st?.reason ?? "no tenant"})  sha256:${w.hash.slice(0, 12)}`);
    }
    for (const e of errors) console.error(`INVALID ${e.file}: ${e.errors[0]}`);
  } else if (cmd === "approve" || cmd === "reject") {
    if (!values.name || !values.email) throw new Error("--name and --email are required");
    const db = openDb(dbPath());
    const u = db.prepare("SELECT id, email, role, tenant_id AS tenantId FROM users WHERE email = ?").get(values.email.trim().toLowerCase()) as Approver | undefined;
    if (!u) throw new Error(`no user ${values.email}`);
    const st = recordDecision(db, u, getWorkflow(values.name), cmd, values.comment ?? "");
    console.log(`${cmd === "approve" ? "Approved" : "Rejected"} ${values.name} as ${u.email}; status now ${st.status} (${st.reason})`);
  } else throw new Error("usage: workflow.mts list|validate|approve|reject|schema");
} catch (e) {
  console.error(e instanceof WorkflowError ? e.message : e instanceof Error ? e.message : e);
  process.exit(1);
}
