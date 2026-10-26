// Sub-tab bar for /settings/*. Updates is shown to system admins only (its page and API 404 for others).
import { Suspense } from "react";
import { SubTabs } from "./tabs";
import { currentUser } from "@/lib/auth/server";
import { isSystemAdmin } from "@/lib/collab";

const TABS = [["/settings/repos", "Repos"], ["/settings/providers", "Providers"], ["/settings/team", "Team"]] as const;
const ADMIN_TABS = [...TABS, ["/settings/updates", "Updates"]] as const;

async function AdminAwareTabs() {
  const u = await currentUser();
  return <SubTabs label="Settings" tabs={u && isSystemAdmin(u) ? ADMIN_TABS : TABS} />;
}

export function SettingsTabs() {
  return <Suspense fallback={<SubTabs label="Settings" tabs={TABS} />}><AdminAwareTabs /></Suspense>;
}
