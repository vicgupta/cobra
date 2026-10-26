import { Suspense } from "react";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { verificationKind } from "@/lib/registration";
import { ConfirmSignup } from "@/components/register";

export const metadata = { title: "Confirm your email · Cobra", referrer: "no-referrer" as const };
type Params = Promise<{ token?: string | string[] }>;

export default function ConfirmPage({ searchParams }: { searchParams: Params }) {
  return <Suspense fallback={<p className="text-sm text-subtle">Loading…</p>}><Body searchParams={searchParams} /></Suspense>;
}

async function Body({ searchParams }: { searchParams: Params }) {
  await connection();
  const t = (await searchParams).token;
  const token = typeof t === "string" ? t : "";
  return <ConfirmSignup token={token} kind={verificationKind(getDb(), token)} />;
}
