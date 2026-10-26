import { CollabPage } from "@/components/collab-page";
import { Card } from "@/components/ui";
import { NewRule, RuleRow } from "@/components/skills";
import { getDb } from "@/lib/workflows/server";
import { listRules, rulesVersion } from "@/lib/skills/review";
import { isSystemAdmin } from "@/lib/collab";

export const metadata = { title: "Skill rules · Settings · Cobra" };

/** System admins only: the rulebook every skill is reviewed against (changes are audited; reviews never block). */
export default function SkillRulesPage() {
  return <CollabPage title="Skill rules">{(u) => {
    if (!isSystemAdmin(u)) return <p className="text-sm text-muted">Only system admins manage the skill rulebook.</p>;
    const rules = listRules(getDb());
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">Every skill create/edit is scored against the enabled rules (advisory rules and rules that aren&apos;t evaluated don&apos;t count). Scores are advice: they never block saving, approving or running. Rules version <code>{rulesVersion(rules)}</code>. Use Re-review on a skill page to re-grade after changes.</p>
        <Card title="Rules"><div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="text-xs text-subtle"><tr><th className="py-1">Code</th><th>Title</th><th>Weight</th><th>Advisory</th><th>Enabled</th><th>Config (JSON)</th><th /></tr></thead>
          <tbody>{rules.map((r) => <RuleRow key={r.id} rule={r} />)}</tbody></table></div></Card>
        <Card title="Add a rule"><NewRule /></Card>
      </div>
    );
  }}</CollabPage>;
}
