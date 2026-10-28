// Client for the root-owned run launcher (launcher/launcher.py): runs one agent step (claude-code, codex or git)
// as the team's own Linux user (cobra-run-<tenantId>) in a hardened transient systemd unit. One request per
// connection on COBRA_LAUNCHER_SOCKET; output streams back as JSON lines, then the exit code and any read-back
// files. Closing the connection stops the run. Tokens travel only over the socket (never argv, files or logs).
import net from "node:net";

export type LaunchEngine = "claude-code" | "codex" | "git";
export type LaunchFile = { path: string; content: string; append?: boolean; mode?: string };
export type LaunchRequest = {
  tenantId: number; runId: string; engine: LaunchEngine; args: string[]; env: Record<string, string>; workspace: string;
  timeoutSec: number; mkdir?: boolean; files?: LaunchFile[]; readBack?: string[]; rmAfter?: string[];
};
export type LaunchResult = { code: number; out: string; files: Record<string, string | null> };

/** Env keys the launcher accepts from Cobra; it sets PATH, HOME, USER, LANG and SHELL itself. */
export const LAUNCH_ENV = new Set(["GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GH_TOKEN",
  "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "CODEX_HOME"]);
const LAUNCHER_SET = new Set(["PATH", "HOME", "LANG", "USER", "SHELL"]);

export function launchEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || LAUNCHER_SET.has(k)) continue;
    if (!LAUNCH_ENV.has(k)) throw new Error(`env ${k} is not allowed through the run launcher`);
    out[k] = v;
  }
  return out;
}

export function launch(socketPath: string, req: LaunchRequest, o: { signal: AbortSignal; log: (s: string) => void }): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    let out = "", buf = "", done = false;
    const sock = net.createConnection(socketPath);
    const finish = (f: () => void) => { if (!done) { done = true; o.signal.removeEventListener("abort", cancel); sock.destroy(); f(); } };
    const cancel = () => finish(() => resolve({ code: -1, out, files: {} })); // closing the socket stops the unit
    if (o.signal.aborted) return cancel();
    o.signal.addEventListener("abort", cancel, { once: true });
    sock.setEncoding("utf8");
    // Don't half-close after the request: the launcher treats EOF from Cobra as a cancel.
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: { t: string; d?: string; code?: number; files?: Record<string, string | null>; error?: string };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === "o" && typeof m.d === "string") { out += m.d; o.log(m.d); }
        else if (m.t === "x") return finish(() => resolve({ code: typeof m.code === "number" ? m.code : -1, out, files: m.files ?? {} }));
        else if (m.t === "e") return finish(() => reject(new Error(`run launcher refused the step: ${m.error ?? "unknown"}`)));
      }
    });
    sock.on("error", (e) => finish(() => reject(new Error(`run launcher unavailable (${(e as NodeJS.ErrnoException).code ?? e.message}); not running the step as the service user`))));
    sock.on("close", () => finish(() => reject(new Error("run launcher closed the connection before the step finished"))));
  });
}
