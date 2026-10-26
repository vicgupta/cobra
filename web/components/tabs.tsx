"use client";

// Sub-tab bar (Settings, Repos), styled like the /admin tabs.
import Link from "next/link";
import { usePathname } from "next/navigation";

export function SubTabs({ label, tabs }: { label: string; tabs: ReadonlyArray<readonly [string, string]> }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b border-border pb-2 text-sm">
      {tabs.map(([href, text]) => (
        <Link key={href} href={href} className={`rounded-md px-3 py-1.5 ${pathname.startsWith(href) ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg"}`}>{text}</Link>
      ))}
    </nav>
  );
}
