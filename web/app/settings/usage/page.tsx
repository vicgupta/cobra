import { CollabPage } from "@/components/collab-page";
import { UsageView } from "@/components/usage-view";
import { parseRange, usageScope } from "@/lib/usage";
import type { Actor } from "@/lib/workflows/store";

export const metadata = { title: "Usage · Settings · Cobra" };

type SP = PageProps<"/settings/usage">["searchParams"];

/** Settings > Usage: every signed-in member sees their own team's usage; system admins see all teams.
 *  The scope comes from the session (usageScope), never from query params. */
export default function SettingsUsagePage({ searchParams }: PageProps<"/settings/usage">) {
  return <CollabPage title="Usage">{(u) => <Body u={u} searchParams={searchParams} />}</CollabPage>;
}

async function Body({ u, searchParams }: { u: Actor; searchParams: SP }) {
  const sp = await searchParams;
  const scope = usageScope(u);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{scope == null ? "All teams (system admin)." : "Your team's runs only."} Token usage and engine-reported cost per run, team and provider/model. Display only: no budgets or limits.</p>
      <UsageView range={parseRange(sp.range)} page={Number(sp.page) || 1} tenantId={scope} base="/settings/usage" />
    </div>
  );
}
