import { Suspense } from "react";
import { connection } from "next/server";
import { AuthForm } from "@/components/auth-form";
import { signupAllowed } from "@/lib/auth/server";

export const metadata = { title: "Sign in · Cobra" };

async function Login() {
  await connection();
  return <AuthForm mode="login" signupAllowed={signupAllowed()} />;
}

export default function LoginPage() {
  return <Suspense fallback={null}><Login /></Suspense>;
}
