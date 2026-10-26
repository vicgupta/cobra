// Sub-tab bar for /settings/*.
import { SubTabs } from "./tabs";

const TABS = [["/settings/templates", "Templates"], ["/settings/team", "Team"], ["/settings/repos", "Repos"], ["/settings/test-run", "Test run"], ["/settings/docs", "Docs"], ["/settings/providers", "Providers"]] as const;

export function SettingsTabs() {
  return <SubTabs label="Settings" tabs={TABS} />;
}
