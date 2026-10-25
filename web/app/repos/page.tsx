import { redirect } from "next/navigation";

/** Old link: Repos now lives under Settings (next.config.ts redirects first and keeps the query string). */
export default function ReposRedirect() {
  redirect("/settings/repos");
}
