// Real side effects for lib/tool-updates.ts (child processes and the filesystem). Runs as the service user.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { Ops } from "./tool-updates";
import type { DB } from "./db";
import { ENV_FALLBACK_TEAM, resolveCredential } from "./provider-credentials";

export const nodeOps: Ops = {
  run: (cmd, args, o = {}) => new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", env: (o.env ?? {}) as NodeJS.ProcessEnv, cwd: o.cwd ?? o.env?.HOME ?? "/", timeout: o.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}` });
    });
  }),
  exists: (p) => existsSync(p),
  readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  readlink: (p) => { try { return readlinkSync(p); } catch { return null; } },
  realpath: (p) => { try { return realpathSync(p); } catch { return null; } },
  rename: (a, b) => renameSync(a, b),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  mkdtemp: (prefix) => { mkdirSync(path.dirname(prefix), { recursive: true }); return mkdtempSync(prefix); },
  symlink: (target, link) => { const tmp = `${link}.cobra-tmp`; rmSync(tmp, { force: true }); symlinkSync(target, tmp); renameSync(tmp, link); },
  env: process.env,
};

/** The daily updater's catalog listings (OpenCode Zen, Cursor models) aren't tied to an admin: they use team 1's
 *  stored OPENCODE_API_KEY / CURSOR_API_KEY (Settings > Providers), else the server env, like team 1's runs. */
export function updaterOps(db: DB, secret: (n: string) => string | undefined): Ops {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [engine, name] of [["opencode", "OPENCODE_API_KEY"], ["cursor", "CURSOR_API_KEY"]] as const) {
    const v = resolveCredential(db, ENV_FALLBACK_TEAM, engine, name, secret("COBRA_SECRET_KEY"), secret);
    if (v) env[name] = v;
  }
  return { ...nodeOps, env };
}
