// Governance: who may approve a workflow definition, and whether the exact
// content hash currently loaded is approved. No Next imports (CLI/tests use it).
import type { DB } from "../db";
import type { LoadedWorkflow } from "./loader";
import type { Governance, Role } from "./schema";

export type Approver = { id: number; email: string; role: Role; tenantId: number };
export type Decision = "approve" | "reject";
export type DecisionRow = { approverId: number; email: string; role: Role; decision: Decision; comment: string; createdAt: number };
export type ApprovalState = { status: "approved" | "rejected" | "pending"; hash: string; decisions: DecisionRow[]; reason: string };

export class PermissionError extends Error {}

/**
 * Self-approval rule (COBRA_WORKFLOW_SELF_APPROVAL):
 *  - "admin" (default): the owner's own approval counts only if the owner is an admin;
 *  - "never": the owner's approval never counts, another approver is always needed;
 *  - "always": the owner's approval counts like anyone else's.
 */
export type SelfApprovalPolicy = "admin" | "never" | "always";
export function selfApprovalPolicy(): SelfApprovalPolicy {
  const v = process.env.COBRA_WORKFLOW_SELF_APPROVAL;
  return v === "never" || v === "always" ? v : "admin";
}

/** Admins can always approve; otherwise the user's email or role must be listed in governance.approvers. */
export function canApprove(user: Pick<Approver, "email" | "role">, gov: Governance): boolean {
  if (user.role === "admin") return true;
  const email = user.email.toLowerCase();
  return gov.approvers.some((a) => (typeof a === "string" ? a === email : a.role === user.role));
}

export function decisions(db: DB, tenantId: number, name: string, hash: string): DecisionRow[] {
  // Latest decision per approver for this exact content hash.
  return db.prepare(`
    SELECT a.approver_id AS approverId, u.email, u.role, a.decision, a.comment, a.created_at AS createdAt
    FROM workflow_approvals a JOIN users u ON u.id = a.approver_id
    WHERE a.tenant_id = ? AND a.workflow = ? AND a.content_hash = ?
      AND a.id = (SELECT MAX(b.id) FROM workflow_approvals b WHERE b.tenant_id = a.tenant_id AND b.workflow = a.workflow AND b.content_hash = a.content_hash AND b.approver_id = a.approver_id)
    ORDER BY a.created_at`).all(tenantId, name, hash) as DecisionRow[];
}

export function approvalState(db: DB, tenantId: number, loaded: LoadedWorkflow, policy = selfApprovalPolicy()): ApprovalState {
  const { workflow: wf, hash } = loaded;
  const gov = wf.governance;
  if (wf.template && !wf.system) return { status: "pending", hash, decisions: [], reason: "templates can't be run; copy into a workflow" };
  // System templates shipped in workflows/templates are pre-approved by the system
  // (the repo review is the approval). Tenant copies need the normal flow.
  if (loaded.origin === "template" && wf.system) return { status: "approved", hash, decisions: [], reason: "system template (pre-approved)" };
  // Only decisions by users who are still allowed approvers count.
  const rows = decisions(db, tenantId, wf.name, hash).filter((d) => canApprove(d, gov));
  if (rows.some((d) => d.decision === "reject")) return { status: "rejected", hash, decisions: rows, reason: "rejected by an approver" };
  const approves = rows.filter((d) => d.decision === "approve");
  const authors = new Set([gov.owner, loaded.author?.toLowerCase()].filter(Boolean));
  const selfCounts = (d: DecisionRow) => !authors.has(d.email) || policy === "always" || (policy === "admin" && d.role === "admin");
  const counted = approves.filter(selfCounts);
  if (counted.length >= gov.min_approvals) return { status: "approved", hash, decisions: rows, reason: `${counted.length}/${gov.min_approvals} approvals` };
  const reason = approves.length > counted.length
    ? `the owner/author can't approve their own change (policy: ${policy}); ${counted.length}/${gov.min_approvals} other approvals`
    : `${counted.length}/${gov.min_approvals} approvals`;
  return { status: "pending", hash, decisions: rows, reason };
}

export function recordDecision(db: DB, user: Approver, loaded: LoadedWorkflow, decision: Decision, comment = "", now = Date.now()): ApprovalState {
  if (decision !== "approve" && decision !== "reject") throw new Error("decision must be approve or reject");
  if (loaded.workflow.template) throw new PermissionError("templates aren't approved or run directly; copy one into a workflow, which then needs approval");
  if (!canApprove(user, loaded.workflow.governance)) throw new PermissionError(`${user.email} is not an approver of workflow '${loaded.workflow.name}'`);
  db.prepare("INSERT INTO workflow_approvals (tenant_id, workflow, content_hash, approver_id, decision, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(user.tenantId, loaded.workflow.name, loaded.hash, user.id, decision, String(comment).slice(0, 2000), now);
  return approvalState(db, user.tenantId, loaded);
}

export const approvedChecker = (db: DB, tenantId: number, loaded: LoadedWorkflow) => (name: string, hash: string) =>
  name === loaded.workflow.name && hash === loaded.hash && approvalState(db, tenantId, loaded).status === "approved";
