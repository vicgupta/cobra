import type { ReactNode } from "react";
import { SettingsTabs } from "@/components/settings-tabs";

/** Workspace settings for every team member (separate from the system-admin Settings tab in /admin). */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <div className="space-y-6"><SettingsTabs />{children}</div>;
}
