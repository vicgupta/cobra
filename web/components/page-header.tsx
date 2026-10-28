import type { ReactNode } from "react";

/** Page title block shared with the Repos pages: optional breadcrumb, h1, description and right-aligned actions. */
export function PageHeader({ title, crumbs, description, actions }: { title: ReactNode; crumbs?: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4" data-page-header>
      <div className="min-w-0 space-y-1.5">
        {crumbs && <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-1.5 text-xs text-subtle [&_a]:rounded [&_a]:no-underline [&_a:hover]:text-fg [&_a:hover]:underline">{crumbs}</nav>}
        <h1 className="break-words text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
