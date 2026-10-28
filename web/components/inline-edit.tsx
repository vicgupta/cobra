"use client";

import { useState, type ReactNode } from "react";
import { ghostBtn } from "./styles";

/** Repos-style row action: a ghost button that swaps in an inline form (with Cancel), like "Edit branch" on Repos. */
export function InlineEdit({ label, children, closed }: { label: string; children: ReactNode; closed?: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) return <span className="inline-flex flex-wrap items-center justify-end gap-2">{closed}<button type="button" className={`${ghostBtn} whitespace-nowrap`} aria-expanded={false} onClick={() => setOpen(true)}>{label}</button></span>;
  return <div className="space-y-2" data-inline-edit-open>{children}<button type="button" className={ghostBtn} onClick={() => setOpen(false)}>Cancel</button></div>;
}
