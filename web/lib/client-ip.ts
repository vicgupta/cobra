// Client IP as seen by the trusted nginx in front of the app (next listens on
// 127.0.0.1 only). nginx sets X-Real-IP to $remote_addr, replacing anything the
// client sent, and appends $remote_addr as the LAST X-Forwarded-For entry.
// Client-supplied X-Forwarded-For entries (the earlier ones) are never used.
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for");
  const last = xff?.split(",").map((s) => s.trim()).filter(Boolean).pop();
  return last || "local";
}
