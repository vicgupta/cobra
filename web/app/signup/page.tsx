import { Suspense } from "react";
import { connection } from "next/server";
import { AuthForm } from "@/components/auth-form";
import { signupAllowed } from "@/lib/auth/server";

export const metadata = { title: "Create a workspace · Cobra" };

async function Signup() {
  await connection();
  if (!signupAllowed()) return <p className="mt-8 text-center text-sm text-zinc-400">Sign-up is turned off. Ask an admin for an account.</p>;
  return <AuthForm mode="signup" />;
}

export default function SignupPage() {
  return <Suspense fallback={null}><Signup /></Suspense>;
}
