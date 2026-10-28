import { Card } from "@/components/ui";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { PageHeader } from "@/components/page-header";
import { InlineEdit } from "@/components/inline-edit";
import { actor } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";
import { ProviderDefaultsForm } from "@/components/provider-form";
import { AuthModeForm, CredentialForm } from "@/components/provider-credentials-form";
import { canManageProviders, codexServerLogin, credentialViews, ENV_FALLBACK_TEAM, getAuthMode, PROVIDER_AUTH, type CredentialView } from "@/lib/provider-credentials";
import { isSystemAdmin } from "@/lib/collab";
import { CODEX_LOGIN_SLOT } from "@/lib/codex-login";
import { listProviders } from "@/lib/providers";
import { getDb, secretValue } from "@/lib/workflows/server";
import { EmptyState, ListSkeleton } from "@/components/collab-view";
import { tableCls, td, th, theadCls } from "@/components/styles";

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


/** Settings > Providers, laid out like Settings > Repos: page header, then Cards holding Repos-style tables with
 *  inline row actions. Credentials: any member of the team; system admins without a team role: read-only.
 *  Defaults: system admins only (server-enforced). Secret values are never sent to the page. */
function Providers({ su }: { su: SessionUser }) {
  const u = actor(su);
  const db = getDb(), admin = isSystemAdmin(u), mgr = canManageProviders(u), t = u.tenantId, team1 = t === ENV_FALLBACK_TEAM;
  const providers = listProviders(db);
  const sk = secretValue("COBRA_SECRET_KEY");
  const creds = (e: keyof typeof PROVIDER_AUTH) => credentialViews(db, t, e, sk, secretValue, mgr);
  const engines = Object.keys(PROVIDER_AUTH) as Array<keyof typeof PROVIDER_AUTH>;
  const codexLogin = team1 && codexServerLogin();
  const byEngine = new Map(providers.map((p) => [p.engine as string, p]));
  return (
    <>
      <Card title="Team provider credentials" subtitle={mgr ? "Agent runs for this team use these credentials and the selected auth method." : "Read-only: only members of this team can change its credentials."}>
        <div data-credentials-manager>
          {engines.length === 0 ? <EmptyState title="No providers configured" /> : (
            <div className="-mx-5 overflow-x-auto"><table className={tableCls}>
              <thead className={theadCls}><tr><th scope="col" className={th}>Provider</th><th scope="col" className={th}>Status</th><th scope="col" className={th}>Auth method</th><th scope="col" className={th}>Default model</th><th scope="col" className={th}>Credentials</th></tr></thead>
              <tbody className="divide-y divide-border">{engines.map((e) => {
                const spec = PROVIDER_AUTH[e], mode = getAuthMode(db, t, e).mode, cs = creds(e), p = byEngine.get(e);
                const ok = connected(mode, cs, e === "codex" && !!codexLogin);
                const ordered = [...cs].sort((x, y) => Number(primaryFor(mode, y)) - Number(primaryFor(mode, x)));
                return (
                  <tr key={e} data-cred-provider={e} className="transition-colors hover:bg-surface-2/40">
                    <td className={`${td} whitespace-nowrap`}><div className="font-medium text-fg" id={`cp-${e}`}>{spec.label}</div>{p && <div className="mt-0.5 font-mono text-xs text-subtle">{p.cli}</div>}</td>
                    <td className={td}><span data-provider-connected={ok ? "yes" : "no"} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${ok ? PILL.set.cls : PILL.unset.cls}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{ok ? "Connected" : "Not connected"}</span></td>
                    <td className={td}>{spec.modes.length > 1 ? <div className="inline-block [&>div]:items-start"><AuthModeForm engine={e} modes={spec.modes} current={mode} disabled={!mgr} /></div> : <span className="text-xs text-subtle">{TYPE.api_key}</span>}</td>
                    <td className={`${td} whitespace-nowrap font-mono text-xs`}>{p?.defaults.model ?? "CLI default"}</td>
                    <td className={`${td} min-w-[22rem]`}>
                      <ul className="space-y-3">{ordered.map((c) => {
                        const main = primaryFor(mode, c);
                        return (
                          <li key={c.name} data-cred-slot={c.name} data-primary={main ? "yes" : "no"} className="space-y-2">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className={`text-sm font-medium ${main ? "text-fg" : "text-fg-soft"}`}>{c.label}{!main && <span className="ml-2 text-xs font-normal text-subtle">not used by this method</span>}</div>
                                <div className="font-mono text-xs text-subtle">{c.name}</div>
                                <Meta c={c} show={mgr} />
                              </div>
                              <StatusPill c={c} />
                            </div>
                            {e === "codex" && c.name === CODEX_LOGIN_SLOT && <CodexLoginInfo c={c} show={mgr} />}
                            {mgr && <CredentialForm engine={e} name={c.name} label={c.label} stored={c.source === "stored"} open={main && !c.set} multiline={e === "codex" && c.name === CODEX_LOGIN_SLOT} />}
                          </li>
                        );
                      })}</ul>
                    </td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </div>
      </Card>
      <Card title="Models and defaults" subtitle={admin ? "Default model and effort for runs that don't pick one. System admins only." : "Set by system admins."}>
        {providers.length === 0 ? <EmptyState title="No providers configured" /> : (
          <div className="-mx-5 overflow-x-auto"><table className={tableCls} data-providers>
            <thead className={theadCls}><tr><th scope="col" className={th}>Provider</th><th scope="col" className={th}>Models</th><th scope="col" className={th}>Effort tiers</th><th scope="col" className={th}>Default model</th><th scope="col" className={th}>Default effort</th>{admin && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody className="divide-y divide-border">{providers.map((p) => (
              <tr key={p.engine} data-provider={p.engine} className="transition-colors hover:bg-surface-2/40">
                <td className={`${td} whitespace-nowrap`}><div className="font-medium text-fg">{p.label}</div><div className="mt-0.5 font-mono text-xs text-subtle">{p.engine} · {p.cli}</div></td>
                <td className={`${td} min-w-[16rem] max-w-md`} data-models><div className="flex flex-wrap gap-1">{p.models.map((m) => <span key={m} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-fg-soft">{m}</span>)}</div><div className="mt-1.5 font-mono text-xs text-subtle">{p.modelFlag}</div></td>
                <td className={`${td} text-xs`} data-tiers>{p.tiers.length ? p.tiers.join(" / ") : "Not supported"}<div className="mt-1.5 font-mono text-subtle">{p.effortFlag}</div></td>
                <td className={`${td} whitespace-nowrap font-mono text-xs`} data-default-model>{p.defaults.model ?? "CLI default"}</td>
                <td className={`${td} whitespace-nowrap text-xs`} data-default-effort>{p.tiers.length ? tier(p.defaults.effort) : "Not supported"}</td>
                {admin && <td className={`${td} text-right`} data-provider-defaults><InlineEdit label="Edit defaults"><ProviderDefaultsForm engine={p.engine} models={p.models} tiers={[...p.tiers]} current={p.defaults} /></InlineEdit></td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

export function ProvidersView() {
  return (
    <div className="space-y-6">
      <PageHeader title="Providers" />
      <Suspense fallback={<ListSkeleton />}><AuthGate>{(su) => <Providers su={su} />}</AuthGate></Suspense>
    </div>
  );
}
