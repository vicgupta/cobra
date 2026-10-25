import { Suspense } from "react";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { resetTokenState, TOKEN_ERRORS } from "@/lib/auth/password-reset";
import { ResetPasswordForm } from "@/components/reset-password-form";

export const metadata = { title: "Choose a new password · Cobra", referrer: "no-referrer" as const };

type Params = Promise<{ token?: string | string[] }>;

export default function ResetPasswordPage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <ResetBody searchParams={searchParams} />
    </Suspense>
  );
}

async function ResetBody({ searchParams }: { searchParams: Params }) {
  await connection(); // token state depends on the current time: render per request
  const t = (await searchParams).token;
  const token = typeof t === "string" ? t : "";
  const state = resetTokenState(getDb(), token);
  return <ResetPasswordForm token={token} initialError={state === "valid" ? null : TOKEN_ERRORS[state]} />;
}
