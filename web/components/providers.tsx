import { Card } from "@/components/ui";
import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { PageHeader } from "@/components/page-header";
import { actor } from "@/lib/workflows/server";
import type { SessionUser } from "@/lib/auth/sessions";
import { CredentialsTable, CustomProvidersTable, DefaultsAction, ModelChips, type CredRow, type CustomRow } from "@/components/provider-credentials-form";
import { canManageProviders, codexServerLogin, credentialViews, customProviderViews, ENV_FALLBACK_TEAM, getAuthMode, PROVIDER_AUTH } from "@/lib/provider-credentials";
import { isSystemAdmin } from "@/lib/collab";
import { CODEX_LOGIN_SLOT } from "@/lib/codex-login";
import { listProviders } from "@/lib/providers";
import { getDb, secretValue } from "@/lib/workflows/server";
import { EmptyState, ListSkeleton } from "@/components/collab-view";
import { tableCls, td, th, theadCls } from "@/components/styles";

const tier = (t: string | null) => t ?? "Default (no flag)";
/** Settings > Providers, laid out like Settings > Repos: Cards holding Repos-style tables with Repos-style row buttons.
 *  Credentials: any member of the team; system admins without a team role: read-only text, no buttons.
 *  Defaults: system admins only (server-enforced). Secret values are never sent to the page (only set/source/last4). */
function Providers({ su }: { su: SessionUser }) {
  const u = actor(su);
  const db = getDb(), admin = isSystemAdmin(u), mgr = canManageProviders(u), t = u.tenantId, team1 = t === ENV_FALLBACK_TEAM;
  const providers = listProviders(db);
  const sk = secretValue("COBRA_SECRET_KEY");
  const engines = Object.keys(PROVIDER_AUTH) as Array<keyof typeof PROVIDER_AUTH>;
  const codexLogin = team1 && codexServerLogin();
  const byEngine = new Map(providers.map((p) => [p.engine as string, p]));
  const rows: CredRow[] = engines.flatMap((e) => {
    const spec = PROVIDER_AUTH[e], mode = getAuthMode(db, t, e).mode, p = byEngine.get(e);
    return credentialViews(db, t, e, sk, secretValue, mgr).map((c) => {
      const login = e === "codex" && c.name === CODEX_LOGIN_SLOT;
      const env = login && !c.set && codexLogin ? "env" : c.source; // server-side `codex login` counts as server env
      const s = c.codexLogin;
      const meta = mgr && login && c.source === "stored" ? (s ? `ChatGPT ${s.plan ?? ""} · ${s.canRefresh ? "auto-refreshes" : "no auto-refresh"}`.replace("  ", " ") : "can't be read; paste again") : null;
      return { engine: e, provider: spec.label, cli: p?.cli ?? null, mode, modes: [...spec.modes], name: c.name, label: c.label, type: c.type, set: c.set || env === "env", source: env, last4: mgr ? c.last4 : null, multiline: login, meta };
    });
  });
  const custom: CustomRow[] = customProviderViews(db, t, sk, mgr).map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, keySet: p.key.set, last4: mgr ? p.key.last4 : null }));
  return (
    <>
      <Card title="Team provider credentials" subtitle={mgr ? "Agent runs for this team use these credentials and the selected auth method." : "Read-only: only members of this team can change its credentials."}>
        <div data-credentials-manager>
          {rows.length === 0 ? <EmptyState title="No providers configured" /> : <CredentialsTable rows={rows} canManage={mgr} />}
        </div>
      </Card>
      <Card title="Models and defaults" subtitle={admin ? "Default model and effort for runs that don't pick one. System admins only." : "Set by system admins."}>
        {providers.length === 0 ? <EmptyState title="No providers configured" /> : (
          <div className="-mx-5 overflow-x-auto"><table className={tableCls} data-providers>
            <thead className={theadCls}><tr>{["Provider", "Models", "Effort tiers", "Default model", "Default effort"].map((h) => <th key={h} scope="col" className={`${th} whitespace-nowrap`}>{h}</th>)}{admin && <th scope="col" className={th}><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody className="divide-y divide-border">{providers.map((p) => (
              <tr key={p.engine} data-provider={p.engine} className="transition-colors hover:bg-surface-2/40">
                <td className={`${td} whitespace-nowrap`}><div className="font-medium text-fg">{p.label}</div><div className="mt-0.5 font-mono text-xs text-subtle">{p.engine} · {p.cli}</div></td>
                <td className={td} data-models><ModelChips models={p.models} /><div className="mt-1.5 whitespace-nowrap font-mono text-xs text-subtle">{p.modelFlag}</div></td>
                <td className={`${td} text-xs`} data-tiers><span className="whitespace-nowrap">{p.tiers.length ? p.tiers.join(" / ") : "Not supported"}</span><div className="mt-1.5 font-mono text-subtle">{p.effortFlag}</div></td>
                <td className={`${td} whitespace-nowrap font-mono text-xs`} data-default-model>{p.defaults.model ?? "CLI default"}</td>
                <td className={`${td} whitespace-nowrap text-xs`} data-default-effort>{p.tiers.length ? tier(p.defaults.effort) : "Not supported"}</td>
                {admin && <td className={`${td} text-right`} data-provider-defaults><DefaultsAction engine={p.engine} models={p.models} tiers={[...p.tiers]} current={p.defaults} /></td>}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title="Custom providers" subtitle="OpenAI-compatible endpoints for this team. Keys are stored encrypted and never shown.">
        <CustomProvidersTable rows={custom} canManage={mgr} />
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
