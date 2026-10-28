import { Card } from "@/components/ui";
import { CollabPage } from "@/components/collab-page";
import { ProviderDefaultsForm } from "@/components/provider-form";
import { AuthModeForm, CredentialForm } from "@/components/provider-credentials-form";
import { canManageProviders, codexServerLogin, credentialViews, ENV_FALLBACK_TEAM, getAuthMode, PROVIDER_AUTH, type CredentialView } from "@/lib/provider-credentials";
import { isSystemAdmin } from "@/lib/collab";
import { CODEX_LOGIN_SLOT } from "@/lib/codex-login";
import { listProviders } from "@/lib/providers";
import { getDb, secretValue } from "@/lib/workflows/server";
import { EmptyState } from "@/components/collab-view";
import { sectionTitle, tableCls, tableWrap, td, th, theadCls } from "@/components/styles";

const tier = (t: string | null) => t ?? "Default (no flag)";
const when = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const TYPE = { api_key: "API key", subscription: "Subscription" } as const;

type Pill = "set" | "env" | "unset";
const pillOf = (c: CredentialView): Pill => (!c.set ? "unset" : c.source === "env" ? "env" : "set");
const PILL: Record<Pill, { text: string; cls: string }> = {
  set: { text: "Connected", cls: "bg-emerald-500/10 text-success ring-emerald-500/30" },
  env: { text: "From server env", cls: "bg-slate-500/15 text-fg-soft ring-slate-400/40" },
  unset: { text: "Not set", cls: "bg-surface-2 text-subtle ring-border-strong" },
};

/** Status pill: Connected (stored) / From server env / Not set. */
function StatusPill({ c }: { c: CredentialView }) {
  const k = pillOf(c);
  return <span data-cred-status={k} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PILL[k].cls}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{PILL[k].text}</span>;
}

/** Muted meta line: last 4, who, when (team members only). */
function Meta({ c, show }: { c: CredentialView; show: boolean }) {
  const bits = show && c.source === "stored" ? [c.last4 ? <>ends <span className="font-mono text-fg-soft">…{c.last4}</span></> : null, c.setBy ? `by ${c.setBy}` : null, c.setAt ? when(c.setAt) : null].filter(Boolean) : [];
  if (!bits.length) return null;
  return <p className="text-xs text-subtle" data-cred-meta>{bits.map((b, i) => <span key={i}>{i ? " · " : ""}{b}</span>)}</p>;
}

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Codex ChatGPT login: masked status (plan, expiry, auto-refresh) and a warning for a bare token. Never the token. */
function CodexLoginInfo({ c, show }: { c: CredentialView; show: boolean }) {
  const s = c.codexLogin;
  return (
    <div className="space-y-2" data-codex-chatgpt-login>
      {show && c.source === "stored" && (s ? (
        <p className="text-xs text-subtle" data-codex-chatgpt-login-status={s.canRefresh ? "refresh" : "token"}>
          ChatGPT {s.plan ? <span className="font-medium capitalize text-fg-soft">{s.plan}</span> : "plan unknown"}
          {" · "}{s.expired ? <span className="text-danger">{s.canRefresh ? "access token expired (renews on the next run)" : `expired ${s.expiresAt ? day(s.expiresAt) : ""}`}</span> : s.expiresAt ? `access token valid until ${day(s.expiresAt)}` : "no expiry"}
          {" · "}{s.canRefresh ? "auto-refreshes" : "no auto-refresh"}
        </p>
      ) : <p className="text-xs text-danger" role="alert">The stored login can&apos;t be read. Paste ~/.codex/auth.json again.</p>)}
      {show && c.source === "stored" && s && !s.canRefresh && (
        <p role="note" data-codex-chatgpt-login-warning className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-warning ring-1 ring-inset ring-amber-500/30">
          Only an access token is stored, so it can&apos;t renew itself{s.expiresAt ? <> and Codex runs stop working {s.expired ? "now" : <>after <strong>{day(s.expiresAt)}</strong></>}</> : null}. Replace it with the full <span className="font-mono">~/.codex/auth.json</span> to keep it refreshed.
        </p>
      )}
      {show && (
        <p className="text-xs text-muted">
          On your computer, run <code className="rounded bg-surface-2 px-1 font-mono">codex login</code> and sign in with ChatGPT, then paste the contents of <code className="rounded bg-surface-2 px-1 font-mono">~/.codex/auth.json</code>. Cobra stores it encrypted and saves the renewed login after each run.
        </p>
      )}
    </div>
  );
}

/** Is the provider usable with its selected auth method? (display only; mirrors which slot the method uses) */
function connected(mode: string, cs: CredentialView[], serverLogin: boolean) {
  const api = cs.some((c) => c.type === "api_key" && c.set), sub = cs.some((c) => c.type === "subscription" && c.set) || serverLogin;
  return mode === "api_key" ? api : mode === "subscription" ? sub : api || sub;
}
const primaryFor = (mode: string, c: CredentialView) => mode === "auto" || mode === c.type;


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
            {admin && (
              <section aria-labelledby="defaults-h" className="space-y-3" data-provider-defaults>
                <h2 id="defaults-h" className={sectionTitle}>Defaults</h2>
                <div className="grid gap-4 lg:grid-cols-2">{providers.map((p) => (
                  <Card key={p.engine} title={`${p.label} defaults`}>
                    <ProviderDefaultsForm engine={p.engine} models={p.models} tiers={[...p.tiers]} current={p.defaults} />
                  </Card>
                ))}</div>
              </section>
            )}
            <section aria-labelledby="creds-h" className="space-y-3" data-credentials-manager>
              <h2 id="creds-h" className={sectionTitle}>Credentials</h2>
              <div className="grid gap-4 lg:grid-cols-2">
                {engines.map((e) => {
                  const spec = PROVIDER_AUTH[e], mode = getAuthMode(db, t, e).mode, cs = creds(e);
                  const ok = connected(mode, cs, e === "codex" && !!codexLogin);
                  const ordered = [...cs].sort((x, y) => Number(primaryFor(mode, y)) - Number(primaryFor(mode, x)));
                  return (
                    <section key={e} data-cred-provider={e} aria-labelledby={`cp-${e}`} className="flex flex-col rounded-xl border border-border bg-surface/60 shadow-sm">
                      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
                        <div className="flex items-center gap-2.5">
                          <h3 id={`cp-${e}`} className="text-base font-semibold text-fg">{spec.label}</h3>
                          <span data-provider-connected={ok ? "yes" : "no"} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${ok ? PILL.set.cls : PILL.unset.cls}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{ok ? "Connected" : "Not connected"}</span>
                        </div>
                        {spec.modes.length > 1 && <AuthModeForm engine={e} modes={spec.modes} current={mode} disabled={!mgr} />}
                      </header>
                      <ul className="divide-y divide-border">
                        {ordered.map((c) => {
                          const main = primaryFor(mode, c);
                          return (
                            <li key={c.name} data-cred-slot={c.name} data-primary={main ? "yes" : "no"} className={`space-y-3 px-5 py-4 ${main ? "" : "bg-surface-2/40"}`}>
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0 space-y-0.5">
                                  <div className={`font-medium ${main ? "text-sm text-fg" : "text-sm text-fg-soft"}`}>{c.label}{!main && <span className="ml-2 text-xs font-normal text-subtle">{TYPE[c.type]} · not used by this method</span>}</div>
                                  <div className="font-mono text-xs text-subtle">{c.name}</div>
                                  <Meta c={c} show={mgr} />
                                </div>
                                <StatusPill c={c} />
                              </div>
                              {e === "codex" && c.name === CODEX_LOGIN_SLOT && <CodexLoginInfo c={c} show={mgr} />}
                              {mgr && <CredentialForm engine={e} name={c.name} label={c.label} stored={c.source === "stored"} open={main && !c.set} multiline={e === "codex" && c.name === CODEX_LOGIN_SLOT} />}
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </section>
            <section aria-labelledby="sum-h" className="space-y-3">
              <h2 id="sum-h" className={sectionTitle}>Models and defaults</h2>
              {providers.length === 0 ? <EmptyState title="No providers configured" /> : <div className={tableWrap}>
                <table className={tableCls} data-providers>
                  <thead className={theadCls}><tr><th scope="col" className={th}>Provider</th><th scope="col" className={th}>Models</th><th scope="col" className={th}>Effort tiers</th><th scope="col" className={th}>Default model</th><th scope="col" className={th}>Default effort</th><th scope="col" className={th}>Credentials</th></tr></thead>
                  <tbody className="divide-y divide-border">{providers.map((p) => (
                    <tr key={p.engine} data-provider={p.engine} className="transition-colors hover:bg-surface-2/40">
                      <td className={td}><div className="font-medium text-fg">{p.label}</div><div className="mt-0.5 font-mono text-xs text-subtle">{p.engine} · {p.cli}</div></td>
                      <td className={`${td} max-w-md`} data-models><div className="flex flex-wrap gap-1">{p.models.map((m) => <span key={m} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-soft">{m}</span>)}</div><div className="mt-1.5 font-mono text-xs text-subtle">{p.modelFlag}</div></td>
                      <td className={`${td} text-xs`} data-tiers>{p.tiers.length ? p.tiers.join(" / ") : "Not supported"}<div className="mt-1.5 font-mono text-subtle">{p.effortFlag}</div></td>
                      <td className={`${td} font-mono text-xs`} data-default-model>{p.defaults.model ?? "CLI default"}</td>
                      <td className={`${td} text-xs`} data-default-effort>{p.tiers.length ? tier(p.defaults.effort) : "Not supported"}</td>
                      <td className={`${td} text-xs`} data-credentials><ul className="space-y-1">{creds(p.engine).map((c) => <li key={c.name} data-secret-status={c.set ? "set" : "empty"} className="flex items-center gap-1.5"><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${c.set ? "bg-emerald-500" : "bg-border-strong"}`} />{TYPE[c.type]}: {c.set ? "set" : "not set"}</li>)}{p.engine === "codex" && <li className="flex items-center gap-1.5"><span aria-hidden className={`h-1.5 w-1.5 rounded-full ${codexLogin ? "bg-emerald-500" : "bg-border-strong"}`} />Server ChatGPT login: {codexLogin ? "yes" : "no"}</li>}</ul></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>}
            </section>
          </div>
        );
      }}
    </CollabPage>
  );
}
