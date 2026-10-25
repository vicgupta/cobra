// In-memory login rate limit: 10 failed tries per key per 15 minutes.
const WINDOW = 15 * 60 * 1000, MAX = 10;
const hits = new Map<string, number[]>();

export function isLimited(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW);
  hits.set(key, recent);
  return recent.length >= MAX;
}
export function recordFailure(key: string, now = Date.now()): void {
  hits.set(key, [...(hits.get(key) ?? []).filter((t) => now - t < WINDOW), now]);
}
export function clearFailures(key: string): void {
  hits.delete(key);
}
