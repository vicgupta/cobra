import { NextResponse } from "next/server";
import { AGENT_ENV, mask, resolveAuthMode, type MaskedSettings } from "@/lib/settings";
import { envFilePath, readManaged, writeManaged, type ManagedKey } from "@/lib/env-file";
import type { AgentId } from "@/lib/types";
import { apiGuard } from "@/lib/auth/server";

const AGENTS: AgentId[] = ["claude-code", "codex"];

async function masked(): Promise<MaskedSettings & { envFile: string }> {
  const v = await readManaged();
  const out = { envFile: envFilePath() } as MaskedSettings & { envFile: string };
  out.github = { token: mask(v.GITHUB_TOKEN), hasToken: !!v.GITHUB_TOKEN };
  for (const a of AGENTS) {
    const sub = v[AGENT_ENV[a].subscription as ManagedKey];
    const key = v[AGENT_ENV[a].apiKey as ManagedKey];
    out[a] = {
      subscription: mask(sub),
      apiKey: mask(key),
      hasSubscription: !!sub,
      hasApiKey: !!key,
      mode: resolveAuthMode({ subscription: !!sub, apiKey: !!key }),
    };
  }
  return out;
}

export async function GET(req: Request) {
  const g = await apiGuard(req, { sharedConfig: true });
  if (g.error) return g.error;
  return NextResponse.json(await masked());
}

/**
 * Body: { [agent]: { subscription?: string | null, apiKey?: string | null }, github?: { token?: string | null } }
 * Omitted / undefined field = keep current value, "" or null = clear, string = set.
 */
export async function POST(req: Request) {
  const g = await apiGuard(req, { sharedConfig: true });
  if (g.error) return g.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, Record<string, unknown>>;
  const changes: Partial<Record<ManagedKey, string>> = {};
  for (const a of AGENTS) {
    const patch = input[a];
    if (!patch || typeof patch !== "object") continue;
    for (const field of ["subscription", "apiKey"] as const) {
      const v = patch[field];
      if (v === undefined) continue;
      if (v !== null && typeof v !== "string") return NextResponse.json({ error: `${a}.${field} must be a string` }, { status: 400 });
      const envKey = AGENT_ENV[a][field] as ManagedKey;
      let value = (v ?? "").trim();
      if (value && envKey === "CODEX_AUTH_JSON") {
        try {
          value = JSON.stringify(JSON.parse(value));
        } catch {
          return NextResponse.json({ error: "Codex auth.json contents must be valid JSON" }, { status: 400 });
        }
      }
      changes[envKey] = value;
    }
  }
  const gh = input.github?.token;
  if (gh !== undefined) {
    if (gh !== null && typeof gh !== "string") return NextResponse.json({ error: "github.token must be a string" }, { status: 400 });
    changes.GITHUB_TOKEN = (gh ?? "").trim();
  }
  try {
    await writeManaged(changes);
  } catch {
    return NextResponse.json({ error: "Could not write the server environment file" }, { status: 500 });
  }
  return NextResponse.json(await masked());
}
