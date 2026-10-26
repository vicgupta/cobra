/** Job 7c: how the signed-in user is shown in the header: their display name, else the part of the email before "@". */
export function displayName(u: { name?: string | null; email: string }): string {
  return u.name?.trim() || u.email.split("@")[0] || "Account";
}
