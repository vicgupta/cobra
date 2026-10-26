// Sub-tab bar for /repos/* (same component and styling as Settings).
import { SubTabs } from "./tabs";

export const REPOS_TABS = [["/repos/overview", "Overview"], ["/repos/issues", "Issues"], ["/repos/pull-requests", "Pull Requests"], ["/repos/branches", "Branches"], ["/repos/activity", "Activity"]] as const;

export function ReposTabs() {
  return <SubTabs label="Repos" tabs={REPOS_TABS} />;
}
