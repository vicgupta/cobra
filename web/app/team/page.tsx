import { redirect } from "next/navigation";

/** Old link: Team now lives under Settings (next.config.ts redirects first and keeps the query string). */
export default function TeamRedirect() {
  redirect("/settings/team");
}
