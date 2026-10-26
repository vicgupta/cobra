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
    <h2 className="mt-6 text-lg font-semibold">Team agents</h2>
    <p className="mt-2 text-sm text-zinc-300">On the <Link className="text-sky-400 hover:underline" href="/agents">Agents</Link> page any team member can create an agent: a name, an engine (Claude Code or Codex), an optional model and default repo, a short <strong>What this agent does</strong> description (optional, up to 500 characters, shown on the agent card) and the required <strong>Prompt / instructions</strong> it runs with (up to 20000 characters). Only the creator, team leads and admins can edit or delete it; others see the prompt read-only. Changing the engine, model or prompt makes a new version, so workflows that use the agent need approval again; editing only the description does not.</p>
    <h2 className="mt-6 text-lg font-semibold">Providers</h2>
    <p className="mt-2 text-sm text-zinc-300"><Link className="text-sky-400 hover:underline" href="/settings/providers">Settings &gt; Providers</Link> lists the coding agents Cobra runs: Claude Code (<code>claude -p</code>) and Codex (<code>codex exec</code>), each with its models and effort tiers (low / medium / high). Simulated runs are a run mode, not a provider. System admins can set a default model and a default effort tier per provider; everyone else sees them read-only. On real runs an agent whose Model is Default uses the provider&apos;s default model, and the effort tier is passed as <code>--effort &lt;tier&gt;</code> (Claude Code) or <code>-c model_reasoning_effort=&quot;&lt;tier&gt;&quot;</code> (Codex). Defaults are not part of an agent&apos;s hash, so changing them never invalidates workflow approvals. Every change is audited.</p>
  </DocsShell>;
}
