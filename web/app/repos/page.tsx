import { redirect } from "next/navigation";

/** /repos opens the Overview tab (next.config.ts redirects first). */
export default function ReposIndex() {
  redirect("/repos/overview");
}
