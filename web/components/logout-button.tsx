"use client";


export function LogoutButton() {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation
    window.location.assign("/login");
  }
  return (
    <button onClick={logout} className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-900">
      Log out
    </button>
  );
}
