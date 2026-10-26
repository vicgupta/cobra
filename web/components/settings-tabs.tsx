// Sub-tab bar for /settings/*. Notifications and Updates are shown to system admins only (its page and API 404 for others).
import { Suspense } from "react";
import { SubTabs } from "./tabs";
import { currentUser } from "@/lib/auth/server";
import { isSystemAdmin } from "@/lib/collab";

const TABS = [["/settings/templates", "Templates"], ["/settings/team", "Team"], ["/settings/repos", "Repos"], ["/settings/docs", "Docs"], ["/settings/providers", "Providers"], ["/settings/usage", "Usage"], ["/settings/skill-rules", "Skill rules"], ["/settings/team-notifications", "Team notifications"], ["/settings/sessions", "Sessions"]] as const;
const ADMIN_TABS = [...TABS, ["/settings/notifications", "Notifications"], ["/settings/updates", "Updates"]] as const;

async function AdminAwareTabs() {
  const u = await currentUser();
  return <SubTabs label="Settings" tabs={u && isSystemAdmin(u) ? ADMIN_TABS : TABS} />;
}

export function SettingsTabs() {
  return <Suspense fallback={<SubTabs label="Settings" tabs={TABS} />}><AdminAwareTabs /></Suspense>;
}
