import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { ProviderDefaultsForm, ProviderSecretForm } from "@/components/provider-form";
import { isSystemAdmin } from "@/lib/collab";
import { listProviderAudit, listProviders, providerSecretStatus } from "@/lib/providers";
import { MODEL_ENV } from "@/lib/agent-models";
import { getDb } from "@/lib/workflows/server";

const tier = (t: string | null) => t ?? "Default (no flag)";
const CREDS: Record<string, string> = { "claude-code": "Settings: OAuth token or API key", codex: "Settings: ChatGPT login or API key", opencode: "Reuses the Codex ChatGPT login (or ANTHROPIC_API_KEY / CODEX_API_KEY)", cursor: "" };

/** Settings > Providers: coding-agent CLIs, models and effort tiers. Defaults are editable by system admins only. */
export function ProvidersView() {
  return (
    <CollabPage title="Providers">
      {(u) => {
        const db = getDb(), admin = isSystemAdmin(u), providers = listProviders(db), log = admin ? listProviderAudit(db, 20) : [];
        return (
          <div className="space-y-6">
            <p className="text-sm text-muted">The coding agents Cobra can run. An agent with Model = Default uses the provider&apos;s default model below; the default effort tier is passed to the CLI on every real run. Defaults don&apos;t change agent hashes or workflow approvals. Simulated runs execute no CLI. {admin ? "As a system admin you can change the defaults." : "View only: system admins set the defaults."}</p>
            <table className="w-full text-sm" data-providers>
              <thead><tr className="text-left text-xs text-subtle"><th className="py-2">Provider</th><th>Models</th><th>Effort tiers</th><th>Default model</th><th>Default effort</th><th>Credentials</th></tr></thead>
              <tbody className="divide-y divide-border">{providers.map((p) => (
                <tr key={p.engine} data-provider={p.engine} className="align-top">
                  <td className="py-2"><div className="font-medium">{p.label}</div><div className="font-mono text-xs text-subtle">{p.engine} · {p.cli}</div></td>
                  <td className="py-2 font-mono text-xs" data-models>{p.models.join(", ")}<div className="mt-1 font-sans text-subtle">flag {p.modelFlag}</div></td>
                  <td className="py-2 text-xs" data-tiers>{p.tiers.length ? p.tiers.join(" / ") : "Not supported"}<div className="mt-1 font-mono text-subtle">{p.effortFlag}</div></td>
                  <td className="py-2 font-mono text-xs" data-default-model>{p.defaults.model ?? "CLI default"}</td>
                  <td className="py-2 text-xs" data-default-effort>{p.tiers.length ? tier(p.defaults.effort) : "Not supported"}</td>
                  <td className="py-2 text-xs" data-credentials>{(() => { const s = providerSecretStatus(db, p.engine); return s ? <span data-secret-status={s.set ? "set" : "empty"}>{s.name}: {s.set ? "set" : "not set"}</span> : <span className="text-subtle">{CREDS[p.engine]}</span>; })()}</td>
                </tr>
              ))}</tbody>
            </table>
            {admin && providers.map((p) => (
              <Card key={p.engine} title={`${p.label} defaults`} subtitle={p.updatedAt ? `Last changed ${new Date(p.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC by ${p.updatedBy}` : "Not changed yet"}>
                <ProviderDefaultsForm engine={p.engine} models={p.models} tiers={[...p.tiers]} current={p.defaults} />
                {(() => { const s = providerSecretStatus(db, p.engine); return s ? <div className="mt-3"><ProviderSecretForm engine={p.engine} label={s.label} name={s.name} help={s.help} set={s.set} /></div> : null; })()}
              </Card>
            ))}
            <Card title="Sources">
              <ul className="space-y-1 text-xs text-muted">{providers.map((p) => <li key={p.engine}><span className="text-fg-soft">{p.label}</span>: models from {p.modelSource} (override with {MODEL_ENV[p.engine]}); effort from {p.effortSource}. The CLI itself accepts {p.cliTiers}; Cobra offers {p.tiers.length ? p.tiers.join(" / ") : "no tiers (Not supported)"}.</li>)}</ul>
            </Card>
            {admin && log.length > 0 && (
              <Card title="Recent provider changes">
                <ul className="space-y-1 text-xs text-muted">{log.map((l, i) => <li key={i}>{new Date(l.at).toISOString().slice(0, 16).replace("T", " ")} UTC · {l.actorEmail} · {l.engine}: model {l.oldModel ?? "default"} → {l.newModel ?? "default"}, effort {l.oldEffort ?? "default"} → {l.newEffort ?? "default"}{l.detail ? ` (${l.detail})` : ""}</li>)}</ul>
              </Card>
            )}
          </div>
        );
      }}
    </CollabPage>
  );
}
