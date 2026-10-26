import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { ProviderDefaultsForm } from "@/components/provider-form";
import { AuthModeForm, CredentialForm, CustomProviderForm } from "@/components/provider-credentials-form";
import { codexServerLogin, credentialViews, customProviderViews, getAuthMode, PROVIDER_AUTH, type CredentialView } from "@/lib/provider-credentials";
import { isSystemAdmin } from "@/lib/collab";
import { listProviderAudit, listProviders } from "@/lib/providers";
import { MODEL_ENV } from "@/lib/agent-models";
import { getDb, secretValue } from "@/lib/workflows/server";
import { OPENROUTER, openRouterStatus } from "@/lib/openrouter";

const tier = (t: string | null) => t ?? "Default (no flag)";
const when = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const TYPE = { api_key: "API key", subscription: "Subscription" } as const;

/** Masked status line: set / not set, last 4, who and when (admins), or the env fallback. */
function Status({ c, admin }: { c: CredentialView; admin: boolean }) {
  if (!c.set) return <span className="text-subtle" data-cred-status="unset">not set</span>;
  if (c.source === "env") return <span data-cred-status="env">set (server env file)</span>;
  return <span data-cred-status="set">set{admin && c.last4 ? <> · ends <span className="font-mono">…{c.last4}</span></> : null}{admin && c.setBy ? ` · by ${c.setBy}` : ""}{admin && c.setAt ? ` · ${when(c.setAt)}` : ""}</span>;
}

/** Settings > Providers: coding-agent CLIs, models and effort tiers. Defaults are editable by system admins only. */
export function ProvidersView() {
  return (
    <CollabPage title="Providers">
      {(u) => {
        const db = getDb(), admin = isSystemAdmin(u), providers = listProviders(db), log = admin ? listProviderAudit(db, 20) : [];
        const or = openRouterStatus(db, secretValue(OPENROUTER.envFallback));
        const sk = secretValue("COBRA_SECRET_KEY");
        const creds = (e: keyof typeof PROVIDER_AUTH) => credentialViews(db, e, sk, secretValue, admin);
        const customs = customProviderViews(db, sk, admin);
        const codexLogin = codexServerLogin();
        return (
          <div className="space-y-6">
            <p className="text-sm text-muted">The coding agents Cobra can run. An agent with Model = Default uses the provider&apos;s default model below; the default effort tier is passed to the CLI on every real run. Defaults don&apos;t change agent hashes or workflow approvals. Simulated runs execute no CLI. {admin ? "As a system admin you can change the defaults and credentials." : "View only."}</p>
            {!admin && <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm" data-non-admin-note>Providers are managed by system admins.</p>}
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
            <Card title="Credentials" subtitle="API keys and subscriptions per provider. Stored encrypted (AES-256-GCM); a stored value overrides the same name in the server env file. Every change is audited.">
              <div className="space-y-5" data-credentials-manager>
                {(Object.keys(PROVIDER_AUTH) as Array<keyof typeof PROVIDER_AUTH>).map((e) => {
                  const spec = PROVIDER_AUTH[e], mode = getAuthMode(db, e);
                  return (
                    <section key={e} data-cred-provider={e} className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-medium">{spec.label}{e === "openrouter" && <span className="ml-2 text-xs font-normal text-subtle">(on hold: existing key storage only)</span>}</h3>
                        {spec.modes.length > 1 ? (admin ? <AuthModeForm engine={e} modes={spec.modes} current={mode.mode} /> : <span className="text-xs text-muted">Auth method: {mode.mode}</span>) : null}
                      </div>
                      {spec.noSubscription && <p className="text-xs text-subtle" data-no-subscription>Subscription: {spec.noSubscription}</p>}
                      {e === "codex" && <p className="text-xs text-subtle" data-codex-login>{spec.serverLogin}: {codexLogin ? "present" : "not found"}. A device/browser login can&apos;t be done from here; run <code>codex login --device-auth</code> as the cobra user on the server, or paste an access token below.</p>}
                      {creds(e).map((c) => (
                        <div key={c.name} className="space-y-1">
                          <div className="text-sm"><span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs">{TYPE[c.type]}</span>{c.label} <span className="font-mono text-xs text-subtle">({c.name})</span>: <Status c={c} admin={admin} /></div>
                          {admin && <CredentialForm engine={e} name={c.name} label={c.label} help={c.help} set={c.set} stored={c.source === "stored"} />}
                        </div>
                      ))}
                    </section>
                  );
                })}
              </div>
            </Card>
            <Card title="Custom providers" subtitle="Any OpenAI-compatible API (base URL + API key + model list), run on the OpenCode engine. Its models appear in the agent model picker as <id>/<model> under OpenCode.">
              <div className="space-y-4" data-custom-providers>
                {customs.length === 0 && <p className="text-sm text-subtle">No custom providers yet.</p>}
                {customs.map((p) => (
                  <div key={p.id} data-custom-provider={p.id} className="space-y-1 border-b border-border pb-3">
                    <div className="text-sm"><span className="font-medium">{p.name}</span> <span className="font-mono text-xs text-subtle">{p.id}</span>{admin && <span className="ml-2 font-mono text-xs text-muted">{p.baseUrl}</span>}</div>
                    <div className="font-mono text-xs text-muted">{p.models.map((m) => `${p.id}/${m}`).join(", ")}</div>
                    <div className="text-xs">API key: <Status c={p.key} admin={admin} />{admin && p.updatedBy ? <span className="text-subtle"> · edited {when(p.updatedAt)} by {p.updatedBy}</span> : null}</div>
                    {admin && <CustomProviderForm initial={{ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models }} keyStored={p.key.set} />}
                  </div>
                ))}
                {admin && <CustomProviderForm />}
              </div>
            </Card>
            <Card title="OpenRouter" subtitle="One shared API key for every team. Pick an openrouter/<vendor>/<model> model on an agent (or as a provider default) to route that run through OpenRouter.">
              <div data-openrouter className="space-y-3 text-sm">
                <p data-secret-status={or.set ? "set" : "empty"}>{or.name}: {or.set ? (or.source === "env" ? "set (server env COBRA_OPENROUTER_API_KEY)" : `set${or.setAt ? ` ${new Date(or.setAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}${admin && or.setBy ? ` by ${or.setBy}` : ""}`) : "not set"}</p>
                <ul className="flex flex-wrap gap-3 text-xs" data-openrouter-engines>{or.engines.map((e) => <li key={e.engine} data-engine={e.engine} data-supported={e.supported ? "yes" : "no"}><span className="font-medium">{e.label}</span>: {e.supported ? "supported" : "Not supported"}</li>)}</ul>
                <p className="font-mono text-xs text-muted" data-openrouter-models>{or.models.join(", ")}</p>
                <p className="text-xs text-subtle">Claude Code lists Anthropic models only; any openrouter/&lt;vendor&gt;/&lt;model&gt; id from openrouter.ai/models can be entered as a custom model. Cursor can&apos;t use OpenRouter.</p>
                <p className="text-xs text-subtle">The key is managed under Credentials &gt; OpenRouter.</p>
              </div>
            </Card>
            <Card title="Sources">
              <ul className="space-y-1 text-xs text-muted">{providers.map((p) => <li key={p.engine}><span className="text-fg-soft">{p.label}</span>: models from {p.modelSource} (override with {MODEL_ENV[p.engine]}); effort from {p.effortSource}. The CLI itself accepts {p.cliTiers}; Cobra offers {p.tiers.length ? p.tiers.join(" / ") : "no tiers (Not supported)"}.</li>)}</ul>
            </Card>
            {admin && log.length > 0 && (
              <Card title="Recent provider changes">
                <ul className="space-y-1 text-xs text-muted">{log.map((l, i) => <li key={i}>{new Date(l.at).toISOString().slice(0, 16).replace("T", " ")} UTC · {l.actorEmail} · {l.engine}: {l.detail && l.oldModel === null && l.newModel === null && l.oldEffort === null && l.newEffort === null ? l.detail : <>model {l.oldModel ?? "default"} → {l.newModel ?? "default"}, effort {l.oldEffort ?? "default"} → {l.newEffort ?? "default"}{l.detail ? ` (${l.detail})` : ""}</>}</li>)}</ul>
              </Card>
            )}
          </div>
        );
      }}
    </CollabPage>
  );
}
