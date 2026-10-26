import { DocsShell } from "@/components/docs";
import { limits as LIMITS } from "@/lib/skills/service";

export const metadata = { title: "Skill docs · Settings · Cobra" };

const li = "list-disc pl-5 text-sm text-fg-soft space-y-1";
export default function SkillDocsPage() {
  return <DocsShell active="skills">
    <h1 className="text-xl font-semibold">Skills (SOPs)</h1>
    <p className="mt-2 text-sm text-fg-soft">A skill is a standard operating procedure: free markdown (the SOP) plus an ordered JSON plan. Skills are native: they are stored and executed directly and never converted to workflow YAML. Workflows keep working unchanged at Workflows.</p>
    <h2 className="mt-8 text-lg font-semibold">The plan</h2>
    <ul className={li}>
      <li><code>inputs</code>: name → {"{"}type string|number|boolean, required, default, description{"}"}.</li>
      <li><code>steps</code> run top to bottom. Each has a unique <code>id</code>, an <code>action</code> (agent, shell, github, approval, call_skill), <code>with</code>, optional <code>when</code> (skip unless true), <code>handoffs</code> ({"{"}from: &quot;inputs.x&quot; or &quot;steps.id.outputs.y&quot;, to: &quot;var&quot;{"}"} fills <code>{"{{var}}"}</code>), <code>outputs</code>, <code>retries</code>, <code>timeout_seconds</code>, <code>secrets</code> (names only) and <code>on_failure</code>: stop, continue or {"{"}goto: later step{"}"}.</li>
      <li><code>section</code>: a heading anchor in the SOP. That section is added to the agent&apos;s prompt; the full SOP is written to <code>.cobra/SOP.md</code> in the checkout (git-excluded) so long SOPs aren&apos;t pasted into prompts.</li>
      <li>Body-only skills: leave the plan empty and a one-step agent plan is derived (input <code>prompt</code>, the SOP is the instructions).</li>
      <li>Limits: SOP {LIMITS.bodyBytes / 1024 / 1024} MB, plan {LIMITS.planBytes / 1024 / 1024} MB, {LIMITS.steps} steps, call_skill depth {LIMITS.depth}. Long prompts only trigger the advisory prompt-length rule.</li>
    </ul>
    <h2 className="mt-8 text-lg font-semibold">Master skill</h2>
    <p className="mt-2 text-sm text-fg-soft">Every team has a built-in skill named <code>workflow</code>. It is an ordinary skill whose plan composes others with <code>call_skill</code> steps (<code>skill</code>, <code>with</code> as the child&apos;s inputs). Cycles and depth over {LIMITS.depth} are rejected at save time; each child is its own run.</p>
    <h2 className="mt-8 text-lg font-semibold">Approval and runs</h2>
    <ul className={li}>
      <li>Real runs need an approval of the current effective hash: the skill&apos;s own SOP+plan, every composed skill and every referenced agent. Any change to any of them returns it to pending.</li>
      <li>Approvers: system admins and team leads of the skill&apos;s team; an author&apos;s own approval only counts for an admin. One approval approves; any reject blocks.</li>
      <li>Simulated runs are dry runs and need no approval: agent steps are simulated, GitHub steps are never sent to GitHub and shell commands are not executed (both reported as would-run), approval steps auto-pass.</li>
    </ul>
    <h2 className="mt-8 text-lg font-semibold">Visibility</h2>
    <p className="mt-2 text-sm text-fg-soft">Skills are visible only to their team (others get 404). System admins see every team&apos;s skills.</p>
  </DocsShell>;
}
