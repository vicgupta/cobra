// The sandbox an agent runs in. Cobra doesn't depend on a provider here: any
// worker (a Docker container, a cloud sandbox) that can run a shell command
// and write a file fits this interface.
//
// Ported from vicgupta/create-ant-factory (assets/template/src/box.mjs).

export interface ExecResult {
  /** Combined stdout and stderr of the command. */
  result?: string;
  status?: string;
}

export interface Workspace {
  exec: { command(command: string): Promise<ExecResult> };
  files: { write(file: { path: string; content: string }): Promise<void> };
}

export interface ShResult {
  code: number;
  output: string;
}

export interface ScriptResult {
  code: number;
  log: string;
  step: string;
  minutes: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Quotes a value for safe use inside a shell command. */
export const q = (value: unknown): string => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Runs a short shell command and returns its output and exit code. Throws on
 * a non-zero exit code unless allowFailure is set. Use runScript for anything
 * that needs bash or may take more than a minute.
 */
export async function sh(ws: Workspace, command: string, { allowFailure = false } = {}): Promise<ShResult> {
  const run = await ws.exec.command(`( ${command} ) 2>&1; echo "__EXIT__$?"`);
  const raw = run.result ?? "";
  const match = /__EXIT__(\d+)\s*$/.exec(raw);
  const code = match ? Number(match[1]) : run.status === "completed" ? 0 : 1;
  const output = raw.replace(/__EXIT__\d+\s*$/, "").trimEnd();
  if (code !== 0 && !allowFailure) {
    throw new Error(`Command failed with exit code ${code}:\n${output.slice(-2000)}`);
  }
  return { code, output };
}

/**
 * Starts a script in its own process group, detached from stdin, so the
 * agent and anything it spawns can be stopped together afterwards.
 */
export function runScriptLaunchCommand(base: string): string {
  return `nohup setsid bash -lc ${q(`echo $$ > ${base}.pid; bash ${base}.sh; echo $? > ${base}.exit`)} < /dev/null > /dev/null 2>&1 & echo started`;
}

export interface RunScriptOptions {
  name: string;
  dir: string;
  body: string[];
  timeoutMinutes?: number;
  onTick?: (minutes: string) => void;
  pollMs?: number;
}

/**
 * Runs a bash script in the background and polls it until it exits or the
 * timeout passes. Lines starting with "#STEP " record the current step.
 */
export async function runScript(
  ws: Workspace,
  { name, dir, body, timeoutMinutes = 20, onTick, pollMs = 10_000 }: RunScriptOptions,
): Promise<ScriptResult> {
  const base = `${dir}/${name}`;
  const script = [
    "#!/bin/bash",
    `exec > ${base}.log 2>&1`,
    ...body.map((line) => (line.startsWith("#STEP ") ? `echo ${q(line.slice(6))} > ${base}.step` : line)),
    "",
  ].join("\n");
  await sh(ws, `mkdir -p ${q(dir)} && rm -f ${base}.exit ${base}.step ${base}.log ${base}.pid`);
  await ws.files.write({ path: `${base}.sh`, content: script });
  await sh(ws, runScriptLaunchCommand(base));
  const stopGroup = () =>
    sh(ws, `/bin/kill -TERM -- -$(cat ${base}.pid) 2>/dev/null; sleep 1; /bin/kill -KILL -- -$(cat ${base}.pid) 2>/dev/null; true`, {
      allowFailure: true,
    });

  const started = Date.now();
  while (Date.now() - started < timeoutMinutes * 60 * 1000) {
    await sleep(pollMs);
    const { output } = await sh(ws, `cat ${base}.exit 2>/dev/null || echo running`);
    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    if (output.trim() === "running") {
      onTick?.(minutes);
      continue;
    }
    const log = (await sh(ws, `tail -n 80 ${base}.log 2>/dev/null`, { allowFailure: true })).output;
    const step = (await sh(ws, `cat ${base}.step 2>/dev/null`, { allowFailure: true })).output.trim();
    await stopGroup();
    return { code: Number(output.trim()), log, step, minutes };
  }
  await stopGroup();
  throw new Error(`"${name}" did not finish within ${timeoutMinutes} minutes.`);
}
