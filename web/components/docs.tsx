import "server-only";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AuthGate } from "@/components/auth-gate";
import { fieldReference, HANDLER_DOCS, GITHUB_NOTE, runFields, type Example } from "@/lib/docs/workflow-docs";

const P = ({ children }: { children: ReactNode }) => <p className="mt-2 text-sm text-fg-soft">{children}</p>;
const C = ({ children }: { children: ReactNode }) => <code className="rounded bg-surface-2 px-1 text-[0.85em]">{children}</code>;
const Note = ({ children }: { children: ReactNode }) => <p className="mt-2 rounded border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning">{children}</p>;

export function DocsNav({ active }: { active: "overview" | "workflows" | "templates" | "skills" }) {
  const l = (href: string, label: string, k: string) => <Link href={href} className={`rounded px-2 py-1 text-sm ${active === k ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}>{label}</Link>;
  return <nav className="flex gap-2" aria-label="Docs sections">{l("/settings/docs", "Overview", "overview")}{l("/settings/docs/workflows", "Workflows", "workflows")}{l("/settings/docs/templates", "Templates", "templates")}{l("/settings/docs/skills", "Skills", "skills")}</nav>;
}

export function DocsShell({ active, children }: { active: "overview" | "workflows" | "templates" | "skills"; children: ReactNode }) {
  return <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><AuthGate><div className="space-y-4"><DocsNav active={active} /><article className="max-w-5xl">{children}</article></div></AuthGate></Suspense>;
}

export function FieldReference() {
  return <>{fieldReference().map((sec) => (
    <section key={sec.path}>
      <h3 className="mt-6 font-medium">{sec.title} <C>{sec.path}</C></h3>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-1 pr-3">Field</th><th className="pr-3">Type</th><th className="pr-3">Required</th><th className="pr-3">Default</th><th className="pr-3">Limits</th><th>Description</th></tr></thead>
        <tbody>{sec.fields.map((f) => <tr key={f.name} className="border-t border-border align-top"><td className="py-1 pr-3"><C>{f.name}</C></td><td className="pr-3 text-fg-soft">{f.type}</td><td className="pr-3">{f.required ? "yes" : "no"}</td><td className="pr-3">{f.default ?? ""}</td><td className="pr-3 text-muted">{f.limits.join(", ")}</td><td className="text-fg-soft">{f.description}</td></tr>)}</tbody>
      </table></div>
    </section>))}</>;
}

export function HandlerReference() {
  return <div className="mt-2 space-y-3">{HANDLER_DOCS.map((h) => (
    <div key={h.uses + (h.action ?? "")} className="rounded border border-border p-3 text-sm">
      <p><C>uses: {h.uses}</C>{h.action && <> <C>with.action: {h.action}</C></>} — {h.summary}</p>
      <ul className="mt-1 list-disc pl-5 text-fg-soft">{h.with.map(([k, v]) => <li key={k}><C>with.{k}</C>{v && ` — ${v}`}</li>)}</ul>
      <p className="mt-1 text-muted">Outputs: {h.outputs}</p>
      {h.notes && <p className="mt-1 text-muted">{h.notes}</p>}
    </div>))}<P>{GITHUB_NOTE}</P></div>;
}

export function Examples({ items }: { items: Example[] }) {
  return <>{items.map((e) => <section key={e.title}><h3 className="mt-6 font-medium">{e.title} <span className="text-xs text-subtle">({e.origin})</span></h3><pre className="mt-2 overflow-x-auto rounded bg-code p-3 text-xs text-code-fg"><code>{e.source}</code></pre></section>)}</>;
}

export function ExpressionDocs() {
  return <>
    <P>Strings may contain <C>{"${{ … }}"}</C>. A value that is exactly one expression keeps its type (number, boolean, object); otherwise the result is text. Paths:</P>
    <ul className="mt-2 list-disc pl-5 text-sm text-fg-soft">
      <li><C>inputs.&lt;name&gt;</C> — a declared input.</li>
      <li><C>steps.&lt;id&gt;.outputs.&lt;key&gt;</C> — a declared output of a step this step <C>needs</C> (directly or transitively). <C>steps.&lt;id&gt;.status</C> is also allowed.</li>
      <li><C>result.&lt;key&gt;</C> — only inside a step&apos;s own <C>outputs</C>, mapping its handler result.</li>
      <li><C>run.&lt;field&gt;</C> — run settings: {runFields.map((f) => <C key={f}>run.{f}</C>).reduce<ReactNode[]>((a, x, i) => (i ? [...a, ", ", x] : [x]), [])}.</li>
    </ul>
    <P>Step <C>if</C> conditions support <C>==</C>, <C>!=</C>, <C>&amp;&amp;</C>, <C>||</C>, <C>!</C>, parentheses, quoted strings, numbers and booleans, with or without <C>{"${{ }}"}</C>. A false condition skips the step. Every reference is checked when the workflow is loaded; an unknown input, step, output or run field is an error.</P>
    <P><strong>Ordering:</strong> <C>needs</C> defines a graph (no unknown ids, no self or circular needs). Steps run <em>one at a time</em> in dependency order; independent steps are not run in parallel. When a step fails, its dependants are skipped and the run fails. A step skipped by its own <C>if</C> does not block its dependants.</P>
    <Note>Input rules as the engine applies them: <C>min</C> is checked only for number inputs; <C>max_length</C> <em>truncates</em> a longer string instead of rejecting it; <C>pattern</C> is checked for string inputs; a choice must be one of <C>options</C>. The loader does not warn when <C>min</C> is set on a non-number input (it is silently ignored).</Note>
    <P>Per step: <C>retries</C> re-runs a failed step up to N more times; <C>timeout_seconds</C> fails a step that runs longer; <C>continue_on_error</C> marks a failed step as succeeded (the error is kept) so its dependants still run.</P>
  </>;
}

export function GovernanceDocs() {
  return <>
    <P>Every workflow and template has <C>governance</C>: an <C>owner</C> email, <C>approvers</C> (emails or <C>{"{ role: admin | team_lead | member }"}</C>), <C>min_approvals</C> and informational <C>reviewers</C> (reviewers are not checked).</P>
    <ul className="mt-2 list-disc pl-5 text-sm text-fg-soft">
      <li>Approval is per content hash. Any edit to the YAML changes the hash and sends the workflow back to pending.</li>
      <li>Steps with <C>uses: agent</C> and <C>with.agent: &lt;name&gt;</C> fold that team agent&apos;s hash into the workflow&apos;s hash, so editing or deleting the agent also sends the workflow back to pending. An unknown agent is an error.</li>
      <li>Admins can always approve; others must match an approver email or role. One rejection by a valid approver makes it rejected. Approved needs at least <C>min_approvals</C> counted approvals.</li>
      <li>Self-approval (server setting COBRA_WORKFLOW_SELF_APPROVAL): <C>admin</C> (default) — the owner/author counts only if they are an admin; <C>never</C>; <C>always</C>.</li>
      <li>The Workflows list has a Status filter (All, Approved, Pending, Rejected; URL <C>?status=</C>, unknown values mean All), the same for every role. Rejected workflows stay visible but can&apos;t run.</li>
      <li>Only approved workflows run. Any team member can start an approved workflow.</li>
    </ul>
  </>;
}
