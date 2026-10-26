"use client";


export function LogoutButton() {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation
    window.location.assign("/login");
  }
  return (
    <button onClick={logout} className="rounded-md border border-border-strong px-2.5 py-1 text-xs text-fg-soft hover:bg-surface">
      Log out
    </button>
  );
}
