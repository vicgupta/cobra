// Sub-tab bar for /settings/*. Updates is shown to system admins only (its page and API 404 for others).
// Notifications is for everyone (own team digest); its all-teams section is admin-only.
import { Suspense } from "react";
import { SubTabs } from "./tabs";
import { currentUser } from "@/lib/auth/server";
import { isSystemAdmin } from "@/lib/collab";

const BASE = [["/settings/repos", "Repos"], ["/settings/providers", "Providers"], ["/settings/team", "Team"]] as const;
const NOTIFY = ["/settings/notifications", "Notifications"] as const;
const TABS = [...BASE, NOTIFY] as const;
const ADMIN_TABS = [...BASE, ["/settings/updates", "Updates"], NOTIFY] as const;

async function AdminAwareTabs() {
  const u = await currentUser();
  return <SubTabs label="Settings" tabs={u && isSystemAdmin(u) ? ADMIN_TABS : TABS} />;
}

export function SettingsTabs() {
  return <Suspense fallback={<SubTabs label="Settings" tabs={TABS} />}><AdminAwareTabs /></Suspense>;
}
