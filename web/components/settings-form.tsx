"use client";

import { useEffect, useState } from "react";
import { AuthBadge } from "./badges";
import { Card } from "./ui";
import { AGENT_ENV, resolveAuthMode, type MaskedSettings } from "@/lib/settings";
import { AGENT_LABEL, type AgentId } from "@/lib/types";

const AGENTS: AgentId[] = ["claude-code", "codex"];
type Draft = { subscription: string; apiKey: string; clearSubscription: boolean; clearApiKey: boolean };
const blank = (): Draft => ({ subscription: "", apiKey: "", clearSubscription: false, clearApiKey: false });

export function SettingsForm() {
  const [saved, setSaved] = useState<MaskedSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/settings")
      .then((r) => r.json())
      .then(setSaved)
      .catch(() => setError("Could not load settings"));
  }, []);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!saved) return <p className="text-sm text-subtle">Loading…</p>;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {AGENTS.map((a) => (
        <AgentForm key={a} agent={a} saved={saved} onSaved={setSaved} />
      ))}
    </div>
  );
}

function AgentForm({ agent, saved, onSaved }: { agent: AgentId; saved: MaskedSettings; onSaved: (s: MaskedSettings) => void }) {
  const [d, setD] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const env = AGENT_ENV[agent];
  const cur = saved[agent];

  const willHaveSub = d.clearSubscription ? false : !!d.subscription || cur.hasSubscription;
  const willHaveKey = d.clearApiKey ? false : !!d.apiKey || cur.hasApiKey;
  const mode = resolveAuthMode({ subscription: willHaveSub, apiKey: willHaveKey });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const patch: Record<string, string | null> = {};
    if (d.clearSubscription) patch.subscription = null; else if (d.subscription) patch.subscription = d.subscription;
    if (d.clearApiKey) patch.apiKey = null; else if (d.apiKey) patch.apiKey = d.apiKey;
    try {
      const r = await fetch("/api/admin/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [agent]: patch }) });
      if (!r.ok) throw new Error((await r.json()).error ?? "Save failed");
      onSaved(await r.json());
      setD(blank());
      setMsg("Saved");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={AGENT_LABEL[agent]} subtitle={<>Mode that would be used: <span className="ml-1"><AuthBadge mode={mode} /></span></>}>
      <form onSubmit={save} className="space-y-5">
        <SecretField
          label={env.subscriptionLabel}
          env={env.subscription}
          help={env.subscriptionHelp}
          multiline={agent === "codex"}
          value={d.subscription}
          savedMask={cur.subscription}
          cleared={d.clearSubscription}
          onChange={(v) => setD({ ...d, subscription: v, clearSubscription: false })}
          onClear={() => setD({ ...d, subscription: "", clearSubscription: !d.clearSubscription })}
        />
        <SecretField
          label="API key (fallback)"
          env={env.apiKey}
          value={d.apiKey}
          savedMask={cur.apiKey}
          cleared={d.clearApiKey}
          onChange={(v) => setD({ ...d, apiKey: v, clearApiKey: false })}
          onClear={() => setD({ ...d, apiKey: "", clearApiKey: !d.clearApiKey })}
        />
        <div className="flex items-center gap-3">
          <button disabled={busy} className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          {msg && <span className="text-xs text-muted">{msg}</span>}
        </div>
      </form>
    </Card>
  );
}

function SecretField(p: {
  label: string; env: string; help?: string; value: string; savedMask: string; cleared: boolean; multiline?: boolean;
  onChange: (v: string) => void; onClear: () => void;
}) {
  const cls = "w-full rounded-md border border-border-strong bg-bg px-3 py-2 font-mono text-sm placeholder:text-faint focus:border-emerald-500 focus:outline-none";
  const placeholder = p.savedMask ? "Saved — type to replace" : "Not set";
  return (
    <label className="block space-y-1.5">
      <span className="flex items-center justify-between text-sm">
        <span>{p.label} <code className="ml-1 text-xs text-subtle">{p.env}</code></span>
        {p.savedMask && (
          <button type="button" onClick={p.onClear} className="text-xs text-muted hover:text-danger">
            {p.cleared ? "Undo clear" : "Clear"}
          </button>
        )}
      </span>
      {p.help && <span className="block text-xs text-subtle">{p.help}</span>}
      <span className="block text-xs">Status: <span className={p.savedMask ? "text-accent" : "text-muted"}>{p.savedMask ? "Set" : "Not set"}</span></span>
      {p.multiline ? (
        <textarea rows={3} autoComplete="off" spellCheck={false} className={cls} placeholder={p.cleared ? "Will be cleared on save" : placeholder} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      ) : (
        <input type="password" autoComplete="off" className={cls} placeholder={p.cleared ? "Will be cleared on save" : placeholder} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      )}
    </label>
  );
}
