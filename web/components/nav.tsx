"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { CobraLogo } from "./icons";
import { ThemeToggle } from "./theme-toggle";
import type { Theme } from "@/lib/theme";

const userLinks = [
  { href: "/", label: "Dashboard" },
  { href: "/workflows", label: "Workflows" },
  { href: "/agents", label: "Agents" },
  { href: "/repos", label: "Repos" },
  { href: "/settings", label: "Settings" },
];
const adminLink = { href: "/admin", label: "Admin" };

export function Nav({ userMenu, admin, signedIn, savedTheme }: { userMenu?: ReactNode; admin?: boolean; signedIn?: boolean; savedTheme?: Theme | null }) {
  const pathname = usePathname();
  const links = admin ? [...userLinks, adminLink] : userLinks;
  const authPage = pathname === "/login";
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <CobraLogo className="h-6 w-6 text-accent" />
          <span>Cobra</span>
          <span className="hidden text-xs font-normal text-subtle sm:inline">software factory</span>
        </Link>
        {!authPage && <nav className="flex gap-1 text-sm">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname === l.href || pathname.startsWith(`${l.href}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 transition ${
                  active ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>}
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle signedIn={signedIn} savedTheme={savedTheme} />
          {!authPage && userMenu}
        </div>
      </div>
    </header>
  );
}
