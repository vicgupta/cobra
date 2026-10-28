type P = { className?: string };

export function CobraLogo({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className} aria-hidden>
      <path d="M12 3c-3 0-5 2-5 4.5S9 11 12 11s5 2 5 4.5S15 21 12 21" />
      <circle cx="12" cy="3.5" r="0.5" fill="currentColor" />
      <path d="M12 21l-2 1.5M12 21l2 1.5" />
    </svg>
  );
}

export function ExternalIcon({ className }: P) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden>
      <path d="M11 3a1 1 0 100 2h2.59l-6.3 6.3a1 1 0 101.42 1.4L15 6.42V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
      <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
    </svg>
  );
}

/** Header role indicator: team lead (shield with star). */
export function TeamLeadIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden data-icon="team-lead">
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
      <path d="M12 8.5l1.1 2.2 2.4.3-1.75 1.7.4 2.4L12 14l-2.15 1.1.4-2.4-1.75-1.7 2.4-.3L12 8.5z" fill="currentColor" strokeWidth={1} />
    </svg>
  );
}

/** Header role indicator: team member (person). */
export function TeamMemberIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden data-icon="team-member">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}
