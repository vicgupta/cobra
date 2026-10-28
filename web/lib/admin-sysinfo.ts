// Host facts for the admin digest's change sections (lib/admin-changes.ts): git commit of the running app,
// commit subjects since the last reported commit, DB backup file names (names and times only), uptimes.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SysInfo } from "./admin-changes";
import type { Health } from "./digest";

const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();

export function collectSysInfo(health: Health, dbFile: string, repoRoot = path.resolve(process.cwd(), "..")): SysInfo {
  let appCommit: string | null = null;
  try { appCommit = git(repoRoot, "rev-parse", "HEAD"); } catch { /* not a git checkout */ }
  let backups: SysInfo["backups"] = null;
  try {
    const dir = path.dirname(dbFile), base = path.basename(dbFile);
    backups = readdirSync(dir).filter((n) => n.startsWith(base) && /bak|backup/i.test(n)).map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }));
  } catch { /* unreadable */ }
  return {
    nodeVersion: process.version, appCommit,
    commitSubjects: (from, to) => { try { return git(repoRoot, "log", "--no-merges", "--format=%h %s", `${from}..${to}`).split("\n").filter(Boolean); } catch { return null; } },
    processUptimeSec: Math.round(process.uptime()), backups,
    diskFreeBytes: health.diskFreeBytes, diskTotalBytes: health.diskTotalBytes, dbBytes: health.dbBytes, hostUptimeSec: Math.round(os.uptime()),
  };
}
