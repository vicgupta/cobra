import type { DB } from "../db";
import { parseTheme, type Theme } from "../theme";

export function getUserTheme(db: DB, userId: number): Theme | null {
  const r = db.prepare("SELECT theme FROM users WHERE id = ?").get(userId) as { theme: string | null } | undefined;
  return parseTheme(r?.theme);
}

/** Saves the user's preference; throws on an invalid value. */
export function setUserTheme(db: DB, userId: number, theme: unknown): Theme {
  const t = parseTheme(theme);
  if (!t) throw new Error("theme must be light, dark or system");
  db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(t, userId);
  return t;
}
