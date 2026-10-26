import { Suspense } from "react";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { checkInvite, signupsAllowed } from "@/lib/registration";
import { InviteAccept, InviteError, RegisterChooser } from "@/components/register";

export const metadata = { title: "Join Cobra", referrer: "no-referrer" as const };

type Params = Promise<{ invite?: string | string[]; mode?: string | string[] }>;

export default function RegisterPage({ searchParams }: { searchParams: Params }) {
  return <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><Body searchParams={searchParams} /></Suspense>;
}

async function Body({ searchParams }: { searchParams: Params }) {
  await connection();
  const sp = await searchParams;
  const db = getDb();
  if (sp.invite !== undefined) {
    const tok = typeof sp.invite === "string" ? sp.invite : "";
    const c = checkInvite(db, tok);
    return c.ok ? <InviteAccept token={tok} team={c.teamName} email={c.email} /> : <InviteError error={c.error} />;
  }
  return <RegisterChooser initial={sp.mode === "join" ? "join" : "create"} signupsOpen={signupsAllowed(db)} />;
}
