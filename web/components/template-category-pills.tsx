import Link from "next/link";
import { TEMPLATE_CATEGORIES } from "@/lib/task-templates";

/** Filter pills on Tasks → Templates. All plus every category; URL is ?tab=templates&category=. */
export function TemplateCategoryPills({ active, counts }: { active: string; counts: Record<string, number> }) {
  const href = (slug: string) => (slug === "all" ? "/tasks?tab=templates" : `/tasks?tab=templates&category=${slug}`);
  const pill = (slug: string, label: string) => {
    const on = active === slug;
    const n = counts[slug] ?? 0;
    return (
      <Link key={slug} href={href(slug)} role="tab" aria-selected={on} data-category={slug}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm ring-1 ring-inset ${on ? "bg-surface-2 font-medium text-fg ring-border-strong" : "text-muted ring-border hover:bg-surface hover:text-fg"}`}>
        {label}
        <span className="text-xs text-subtle">{n}</span>
      </Link>
    );
  };
  return (
    <nav aria-label="Template categories" className="flex flex-wrap items-center gap-2" data-testid="template-category-pills" role="tablist">
      {pill("all", "All")}
      {TEMPLATE_CATEGORIES.map((c) => pill(c.slug, c.label))}
    </nav>
  );
}
