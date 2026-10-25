import { redirect } from "next/navigation";

/** Old link: Templates now lives under Settings. */
export default function TemplatesRedirect() {
  redirect("/settings/templates");
}
