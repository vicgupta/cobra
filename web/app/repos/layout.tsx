import { Suspense, type ReactNode } from "react";
import { ReposTabs } from "@/components/repos-tabs";

/** Repo work for every team member: overview, issues, pull requests, branches, activity. */
export default function ReposLayout({ children }: { children: ReactNode }) {
  // Suspense: the tab bar reads the pathname, which is request data on the dynamic [owner]/[repo] pages.
  return <div className="space-y-6"><Suspense fallback={<div className="h-10 border-b border-border" />}><ReposTabs /></Suspense>{children}</div>;
}
