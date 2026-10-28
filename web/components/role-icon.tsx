import { TeamLeadIcon, TeamMemberIcon } from "./icons";

export type HeaderRole = "team_lead" | "member";

/** Role label shown only as tooltip / accessible name (never as visible header text). */
export function roleLabel(role: HeaderRole): string {
  return role === "team_lead" ? "Team lead" : "Team member";
}

/** Header role indicator: an icon only, with a hover/focus tooltip and an accessible label. */
export function RoleIcon({ role }: { role: HeaderRole }) {
  const label = roleLabel(role);
  const Icon = role === "team_lead" ? TeamLeadIcon : TeamMemberIcon;
  return (
    <span className="group relative inline-flex">
      <span
        data-user-role={role}
        role="img"
        aria-label={label}
        tabIndex={0}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-soft hover:bg-surface hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span
        role="tooltip"
        data-role-tooltip
        className="pointer-events-none absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-fg invisible shadow-sm group-hover:visible group-focus-within:visible"
      >
        {label}
      </span>
    </span>
  );
}
