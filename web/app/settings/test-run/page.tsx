import NewRunPage from "../../runs/new/page";

export const metadata = { title: "Test run · Settings · Cobra" };

/** Job 24: Test run lives under Settings; /runs/new redirects here (307, query kept). Same page component. */
export default function SettingsTestRunPage() {
  return <NewRunPage />;
}
