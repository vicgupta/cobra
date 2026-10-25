import Link from "next/link";
import { DocsShell } from "@/components/docs";

export const metadata = { title: "Docs · Settings · Cobra" };

export default function DocsPage() {
  return <DocsShell active="overview">
    <h1 className="text-xl font-semibold">Docs</h1>
    <p className="mt-2 text-sm text-zinc-300">How to write Cobra workflows and templates. Field tables are generated from the same schema the server validates with, and every example is a real file that the test suite loads.</p>
    <ul className="mt-4 list-disc pl-5 text-sm">
      <li><Link className="text-sky-400 hover:underline" href="/settings/docs/workflows">Workflows</Link> — fields, step handlers, expressions, ordering, approval and examples.</li>
      <li><Link className="text-sky-400 hover:underline" href="/settings/docs/templates">Templates</Link> — what a template is, how it differs from a workflow, and examples.</li>
    </ul>
  </DocsShell>;
}
