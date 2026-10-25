"use client";

// Sub-tab bar for /settings/*, styled like the /admin tabs.
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [["/settings/templates", "Templates"]] as const;

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex flex-wrap gap-1 border-b border-zinc-800 pb-2 text-sm">
      {TABS.map(([href, label]) => (
        <Link key={href} href={href} className={`rounded-md px-3 py-1.5 ${pathname.startsWith(href) ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"}`}>{label}</Link>
      ))}
    </nav>
  );
}
