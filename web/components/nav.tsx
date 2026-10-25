"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { CobraLogo } from "./icons";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/runs/new", label: "Test run" },
  { href: "/settings", label: "Settings" },
] as const;

export function Nav({ userMenu }: { userMenu?: ReactNode }) {
  const pathname = usePathname();
  const authPage = pathname === "/login" || pathname === "/signup";
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <CobraLogo className="h-6 w-6 text-emerald-400" />
          <span>Cobra</span>
          <span className="hidden text-xs font-normal text-zinc-500 sm:inline">software factory</span>
        </Link>
        {!authPage && <nav className="flex gap-1 text-sm">
          {links.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-md px-3 py-1.5 transition ${
                  active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>}
        {!authPage && userMenu}
      </div>
    </header>
  );
}
