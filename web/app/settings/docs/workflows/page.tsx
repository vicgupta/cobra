import { DocsShell, FieldReference, HandlerReference, ExpressionDocs, GovernanceDocs, Examples } from "@/components/docs";
import { workflowExamples } from "@/lib/docs/workflow-docs";

export const metadata = { title: "Workflow docs · Settings · Cobra" };

export default function WorkflowDocsPage() {
  return <DocsShell active="workflows">
    <h1 className="text-xl font-semibold">Workflows</h1>
    <p className="mt-2 text-sm text-fg-soft">A workflow is a YAML file: built in (<code>workflows/*.yaml</code>), in a team repo (<code>.cobra/workflows/&lt;name&gt;.yaml</code>, file name must equal <code>name</code>), or stored for your team. Editors can use <code>workflows/workflow.schema.json</code> for completion.</p>
    <h2 className="mt-8 text-lg font-semibold">Field reference</h2>
    <FieldReference />
    <h2 className="mt-8 text-lg font-semibold">Step handlers (<code>uses:</code>)</h2>
    <HandlerReference />
    <h2 className="mt-8 text-lg font-semibold">Expressions and ordering</h2>
    <ExpressionDocs />
    <h2 className="mt-8 text-lg font-semibold">Governance and approval</h2>
    <GovernanceDocs />
    <h2 className="mt-8 text-lg font-semibold">Examples</h2>
    <Examples items={workflowExamples()} />
  </DocsShell>;
}
