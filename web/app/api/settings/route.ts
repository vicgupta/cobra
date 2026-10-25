import { NextResponse } from "next/server";
import { emptySettings, mask, resolveAuthMode, type MaskedSettings, type Settings } from "@/lib/settings";
import { readJson, writeJson } from "@/lib/store";
import type { AgentId } from "@/lib/types";

const FILE = "settings.json";
const AGENTS: AgentId[] = ["claude-code", "codex"];

function toMasked(s: Settings): MaskedSettings {
  const out = {} as MaskedSettings;
  for (const a of AGENTS) {
    const f = s[a];
    out[a] = {
      subscription: mask(f.subscription),
      apiKey: mask(f.apiKey),
      hasSubscription: !!f.subscription,
      hasApiKey: !!f.apiKey,
      mode: resolveAuthMode({ subscription: !!f.subscription, apiKey: !!f.apiKey }),
    };
  }
  return out;
}

export async function GET() {
  const s = await readJson<Settings>(FILE, emptySettings());
  return NextResponse.json(toMasked({ ...emptySettings(), ...s }));
}

/**
 * Body: { [agent]: { subscription?: string | null, apiKey?: string | null } }
 * Omitted / undefined field = keep current value, "" or null = clear, string = set.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const current = { ...emptySettings(), ...(await readJson<Settings>(FILE, emptySettings())) };
  const input = (body ?? {}) as Record<string, Record<string, unknown>>;
  for (const a of AGENTS) {
    const patch = input[a];
    if (!patch || typeof patch !== "object") continue;
    for (const key of ["subscription", "apiKey"] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      if (v !== null && typeof v !== "string") return NextResponse.json({ error: `${a}.${key} must be a string` }, { status: 400 });
      current[a][key] = (v ?? "").trim();
    }
  }
  await writeJson(FILE, current);
  return NextResponse.json(toMasked(current));
}
