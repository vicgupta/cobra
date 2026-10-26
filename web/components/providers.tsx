import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { ProviderDefaultsForm } from "@/components/provider-form";
import { AuthModeForm, CredentialForm } from "@/components/provider-credentials-form";
import { canManageProviders, codexServerLogin, credentialViews, ENV_FALLBACK_TEAM, getAuthMode, PROVIDER_AUTH, type CredentialView } from "@/lib/provider-credentials";
import { isSystemAdmin } from "@/lib/collab";
import { listProviderAudit, listProviders } from "@/lib/providers";
import { MODEL_ENV } from "@/lib/agent-models";
import { getDb, secretValue } from "@/lib/workflows/server";

const tier = (t: string | null) => t ?? "Default (no flag)";
const when = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const TYPE = { api_key: "API key", subscription: "Subscription" } as const;

/** Masked status line: set / not set, last 4, who and when (team members), or the env fallback (team 1). */
function Status({ c, admin }: { c: CredentialView; admin: boolean }) {
  if (!c.set) return <span className="text-subtle" data-cred-status="unset">not set</span>;
  if (c.source === "env") return <span data-cred-status="env">set (server env file)</span>;
  return <span data-cred-status="set">set{admin && c.last4 ? <> · ends <span className="font-mono">…{c.last4}</span></> : null}{admin && c.setBy ? ` · by ${c.setBy}` : ""}{admin && c.setAt ? ` · ${when(c.setAt)}` : ""}</span>;
}

/** Settings > Providers: coding-agent CLIs, models and effort tiers (defaults: system admins), and the team's own
 *  credentials (any member of the team; system admins without a team role: read-only). */
export function ProvidersView() {
  return (
    <CollabPage title="Providers">
      {(u) => {
        const db = getDb(), admin = isSystemAdmin(u), mgr = canManageProviders(u), t = u.tenantId, team1 = t === ENV_FALLBACK_TEAM;
        const providers = listProviders(db), log = listProviderAudit(db, t, 20);
        const sk = secretValue("COBRA_SECRET_KEY");
        const creds = (e: keyof typeof PROVIDER_AUTH) => credentialViews(db, t, e, sk, secretValue, mgr);
        const engines = Object.keys(PROVIDER_AUTH) as Array<keyof typeof PROVIDER_AUTH>;
        const codexLogin = team1 && codexServerLogin();
        return (
          <div className="space-y-6">
            <p className="text-sm text-muted">The coding agents Cobra can run. An agent with Model = Default uses the provider&apos;s default model below; the default effort tier is passed to the CLI on every real run. Defaults don&apos;t change agent hashes or workflow approvals. Simulated runs execute no CLI. {admin ? "As a system admin you can change the defaults." : ""} MVP build: Claude Code and Codex only. Credentials belong to this team: every team member can add, replace and delete them, and only this team&apos;s runs use them.</p>
            {!mgr && <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm" data-read-only-note>Providers are managed by the members of this team. As a system admin without a team role you have a read-only view.</p>}
            <table className="w-full text-sm" data-providers>
              <thead><tr className="text-left text-xs text-subtle"><th className="py-2">Provider</th><th>Models</th><th>Effort tiers</th><th>Default model</th><th>Default effort</th><th>Credentials</th></tr></thead>
              <tbody className="divide-y divide-border">{providers.map((p) => (
                <tr key={p.engine} data-provider={p.engine} className="align-top">
                  <td className="py-2"><div className="font-medium">{p.label}</div><div className="font-mono text-xs text-subtle">{p.engine} · {p.cli}</div></td>
                  <td className="py-2 font-mono text-xs" data-models>{p.models.join(", ")}<div className="mt-1 font-sans text-subtle">flag {p.modelFlag}</div></td>
                  <td className="py-2 text-xs" data-tiers>{p.tiers.length ? p.tiers.join(" / ") : "Not supported"}<div className="mt-1 font-mono text-subtle">{p.effortFlag}</div></td>
                  <td className="py-2 font-mono text-xs" data-default-model>{p.defaults.model ?? "CLI default"}</td>
                  <td className="py-2 text-xs" data-default-effort>{p.tiers.length ? tier(p.defaults.effort) : "Not supported"}</td>
                  <td className="py-2 text-xs" data-credentials><ul className="space-y-0.5">{creds(p.engine).map((c) => <li key={c.name} data-secret-status={c.set ? "set" : "empty"}>{TYPE[c.type]}: {c.set ? "set" : "not set"}</li>)}{p.engine === "codex" && <li>Server ChatGPT login: {codexLogin ? "yes" : "no"}</li>}</ul></td>
                </tr>
              ))}</tbody>
            </table>
            {admin && providers.map((p) => (
              <Card key={p.engine} title={`${p.label} defaults`} subtitle={p.updatedAt ? `Last changed ${new Date(p.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC by ${p.updatedBy}` : "Not changed yet"}>
                <ProviderDefaultsForm engine={p.engine} models={p.models} tiers={[...p.tiers]} current={p.defaults} />
              </Card>
            ))}
            <Card title="Credentials" subtitle={`This team's API keys and subscriptions per provider. Stored encrypted (AES-256-GCM)${team1 ? "; a stored value overrides the same name in the server env file (team 1 only)" : "; no server env fallback for this team"}. Every change is audited.`}>
              <div className="space-y-5" data-credentials-manager>
                {engines.map((e) => {
                  const spec = PROVIDER_AUTH[e], mode = getAuthMode(db, t, e);
                  return (
                    <section key={e} data-cred-provider={e} className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-medium">{spec.label}</h3>
                        {spec.modes.length > 1 ? (mgr ? <AuthModeForm engine={e} modes={spec.modes} current={mode.mode} /> : <span className="text-xs text-muted">Auth method: {mode.mode}</span>) : null}
                      </div>
                      {spec.noSubscription && <p className="text-xs text-subtle" data-no-subscription>Subscription: {spec.noSubscription}</p>}
                      {e === "codex" && team1 && <p className="text-xs text-subtle" data-codex-login>{spec.serverLogin}: {codexLogin ? "present" : "not found"}. A device/browser login can&apos;t be done from here; run <code>codex login --device-auth</code> as the cobra user on the server, or paste an access token below.</p>}
                      {creds(e).map((c) => (
                        <div key={c.name} className="space-y-1">
                          <div className="text-sm"><span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs">{TYPE[c.type]}</span>{c.label} <span className="font-mono text-xs text-subtle">({c.name})</span>: <Status c={c} admin={mgr} /></div>
                          {mgr && <CredentialForm engine={e} name={c.name} label={c.label} help={c.help} set={c.set} stored={c.source === "stored"} />}
                        </div>
                      ))}
                    </section>
                  );
                })}
              </div>
            </Card>
            <Card title="Sources">
              <ul className="space-y-1 text-xs text-muted">{providers.map((p) => <li key={p.engine}><span className="text-fg-soft">{p.label}</span>: models from {p.modelSource} (override with {MODEL_ENV[p.engine]}); effort from {p.effortSource}. The CLI itself accepts {p.cliTiers}; Cobra offers {p.tiers.length ? p.tiers.join(" / ") : "no tiers (Not supported)"}.</li>)}</ul>
            </Card>
            {log.length > 0 && (
              <Card title="Recent provider changes" subtitle="This team's credential changes, plus system-wide default changes.">
                <ul className="space-y-1 text-xs text-muted">{log.map((l, i) => <li key={i}>{new Date(l.at).toISOString().slice(0, 16).replace("T", " ")} UTC · {l.actorEmail} · {l.engine}: {l.detail && l.oldModel === null && l.newModel === null && l.oldEffort === null && l.newEffort === null ? l.detail : <>model {l.oldModel ?? "default"} → {l.newModel ?? "default"}, effort {l.oldEffort ?? "default"} → {l.newEffort ?? "default"}{l.detail ? ` (${l.detail})` : ""}</>}</li>)}</ul>
              </Card>
            )}
          </div>
        );
      }}
    </CollabPage>
  );
}
