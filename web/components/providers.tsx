import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { ProviderDefaultsForm } from "@/components/provider-form";
import { AuthModeForm, CredentialForm } from "@/components/provider-credentials-form";
import { canManageProviders, codexServerLogin, credentialViews, ENV_FALLBACK_TEAM, getAuthMode, PROVIDER_AUTH, type CredentialView } from "@/lib/provider-credentials";
import { isSystemAdmin } from "@/lib/collab";
import { listProviders } from "@/lib/providers";
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
        const providers = listProviders(db);
        const sk = secretValue("COBRA_SECRET_KEY");
        const creds = (e: keyof typeof PROVIDER_AUTH) => credentialViews(db, t, e, sk, secretValue, mgr);
        const engines = Object.keys(PROVIDER_AUTH) as Array<keyof typeof PROVIDER_AUTH>;
        const codexLogin = team1 && codexServerLogin();
        return (
          <div className="space-y-6">
            {admin && providers.map((p) => (
              <Card key={p.engine} title={`${p.label} defaults`}>
                <ProviderDefaultsForm engine={p.engine} models={p.models} tiers={[...p.tiers]} current={p.defaults} />
              </Card>
            ))}
            <Card title="Credentials">
              <div className="space-y-5" data-credentials-manager>
                {engines.map((e) => {
                  const spec = PROVIDER_AUTH[e], mode = getAuthMode(db, t, e);
                  return (
                    <section key={e} data-cred-provider={e} className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-medium">{spec.label}</h3>
                        {spec.modes.length > 1 ? (mgr ? <AuthModeForm engine={e} modes={spec.modes} current={mode.mode} /> : <span className="text-xs text-muted">Auth method: {mode.mode}</span>) : null}
                      </div>
                      {creds(e).map((c) => (
                        <div key={c.name} className="space-y-1">
                          <div className="text-sm"><span className="mr-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs">{TYPE[c.type]}</span>{c.label} <span className="font-mono text-xs text-subtle">({c.name})</span>: <Status c={c} admin={mgr} /></div>
                          {mgr && <CredentialForm engine={e} name={c.name} label={c.label} stored={c.source === "stored"} />}
                        </div>
                      ))}
                    </section>
                  );
                })}
              </div>
            </Card>
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
          </div>
        );
      }}
    </CollabPage>
  );
}
