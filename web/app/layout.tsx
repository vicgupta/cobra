import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { Nav } from "@/components/nav";
import { currentUser } from "@/lib/auth/server";
import { isSystemAdmin } from "@/lib/admin/gate";
import { UserMenu } from "@/components/user-menu";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Cobra — Build and Release Automation",
  description: "Approved GitHub issues → agent PRs → human review.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <Suspense fallback={null}><NavSlot /></Suspense>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>
        <footer className="border-t border-zinc-800 py-4 text-center text-xs text-zinc-500">
          Cobra · Command Orchestration for Build and Release Automation · nothing auto-merges
        </footer>
      </body>
    </html>
  );
}

async function NavSlot() {
  const u = await currentUser();
  return <Nav admin={!!u && isSystemAdmin(u.email)} userMenu={<Suspense fallback={null}><UserMenu /></Suspense>} />;
}
