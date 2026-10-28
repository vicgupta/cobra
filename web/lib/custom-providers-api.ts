// Request handling for /api/custom-providers (routes are thin wrappers so this is testable without Next).
import type { DB } from "./db";
import { CollabError } from "./collab";
import { addCustomProvider, canManageProviders, customProviderViews, deleteCustomProvider, listCustomProviders, storedCredential, updateCustomProvider, CUSTOM_ENGINE, CUSTOM_KEY } from "./provider-credentials";
import { testCustomProvider, type TestDeps } from "./custom-provider-test";

type User = { id: number; email: string; role: string; tenantId: number };
export type ApiResult = { status: number; body: unknown };
const wrap = async (fn: () => unknown | Promise<unknown>, ok = 200): Promise<ApiResult> => {
  try { return { status: ok, body: await fn() }; } catch (e) {
    if (e instanceof CollabError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
};
const onlyMembers = (u: User) => { if (!canManageProviders(u)) throw new CollabError(403, "Only team members can add custom providers."); };

/** Team members: masked key status (set + last4). System admins (read-only): names, models, set / not set. */
export function listApi(db: DB, u: User, sk: string | undefined): ApiResult {
  const m = canManageProviders(u);
  return { status: 200, body: { canManage: m, providers: customProviderViews(db, u.tenantId, sk, m).map((p) => m ? p : { id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, key: { set: p.key.set } }) } };
}
export const addApi = (db: DB, u: User, b: Record<string, unknown> | null, sk: string | undefined) =>
  wrap(() => { if (!b) throw new CollabError(400, "send JSON"); return { provider: addCustomProvider(db, u, b, sk) }; }, 201);
export const updateApi = (db: DB, u: User, id: string, b: Record<string, unknown> | null, sk: string | undefined) =>
  wrap(() => { if (!b) throw new CollabError(400, "send JSON"); return { provider: updateCustomProvider(db, u, id, b, sk) }; });
export const deleteApi = (db: DB, u: User, id: string) => wrap(() => { deleteCustomProvider(db, u, id); return { ok: true }; });

/** Test unsaved settings from the add form: { baseUrl, apiKey, models }. Team members only; nothing is saved. */
export const testDraftApi = (u: User, b: Record<string, unknown> | null, deps?: TestDeps) =>
  wrap(async () => {
    onlyMembers(u);
    if (!b) throw new CollabError(400, "send JSON");
    return testCustomProvider({ baseUrl: b.baseUrl, apiKey: typeof b.apiKey === "string" ? b.apiKey.trim() : undefined, models: b.models }, deps);
  });

/** Test a saved provider with its stored key (the caller's team only). */
export const testSavedApi = (db: DB, u: User, id: string, sk: string | undefined, deps?: TestDeps) =>
  wrap(async () => {
    onlyMembers(u);
    const p = listCustomProviders(db, u.tenantId).find((x) => x.id === id);
    if (!p) throw new CollabError(404, `no custom provider '${id}'`);
    const key = storedCredential(db, u.tenantId, CUSTOM_ENGINE(id), CUSTOM_KEY, sk);
    if (!key) throw new CollabError(400, "no API key stored for this provider; replace the key first");
    return testCustomProvider({ baseUrl: p.baseUrl, apiKey: key, models: p.models }, deps);
  });
