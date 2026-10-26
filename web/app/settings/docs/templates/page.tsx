import { DocsShell, GovernanceDocs, Examples } from "@/components/docs";
import { templateExamples } from "@/lib/docs/workflow-docs";

export const metadata = { title: "Template docs · Settings · Cobra" };

export default function TemplateDocsPage() {
  return <DocsShell active="templates">
    <h1 className="text-xl font-semibold">Templates</h1>
    <p className="mt-2 text-sm text-fg-soft">A template is a workflow file with <code>template: true</code>. It uses exactly the same fields (see Workflows) but is never run or approved directly.</p>
    <h2 className="mt-8 text-lg font-semibold">Template vs workflow</h2>
    <ul className="mt-2 list-disc pl-5 text-sm text-fg-soft">
      <li><strong>Templates never run.</strong> Starting or approving one is refused; copy it into a workflow first.</li>
      <li>System templates (<code>system: true</code>, shipped in <code>workflows/templates/</code>) are shown as pre-approved because the repo review is the approval; that applies only to the template itself.</li>
      <li>Using a template (Settings &gt; Templates) creates a team workflow: <code>template</code> and <code>system</code> are removed, <code>name</code> is set to the new name and <code>governance.owner</code> to you. The workflow records the template&apos;s name and content hash, and its page links back to the template and says whether it came from the current version.</li>
      <li>The copy is a normal workflow with its own hash and needs the normal approval below. Later template edits do not change existing copies.</li>
    </ul>
    <h2 className="mt-8 text-lg font-semibold">Governance and approval</h2>
    <GovernanceDocs />
    <h2 className="mt-8 text-lg font-semibold">Examples</h2>
    <Examples items={templateExamples()} />
  </DocsShell>;
}
