'use server';

/**
 * The administration actions. Plain form posts and redirects. The secret
 * field is read once and handed to the store; it is not echoed into a
 * redirect, a log or an error.
 */

import { redirect } from 'next/navigation';

import { ENVIRONMENTS, type Environment, VAULT_PROVIDERS, type VaultProvider, revokeCredential, saveCredential, store } from './credentials.ts';
import { catalogueWithChange, checkProposal, resolveProductCatalogue } from './products.ts';
import { decideRevision, proposeRevision } from './revisions.ts';
import { railsWithChange, resolveRailsConfiguration } from './rails.ts';
import { parseRailsConfiguration } from '@sanad/core/config/rails.ts';
import { ADAPTER_CATALOGUE } from '@sanad/adapters/catalogue.ts';
import { proposeRevision as proposePure } from '@sanad/core/config/revision.ts';
import { isTenantCode } from '@sanad/config/loader.ts';
import { randomUUID } from 'node:crypto';
import { currentAdmin, developmentPrincipalFor, endAdminSession, startAdminSession } from './session.ts';

const field = (form: FormData, name: string): string => { const v = form.get(name); return typeof v === 'string' ? v.trim() : ''; };
const back = (to: string, notice: string): never => redirect(`${to}${to.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`);

export async function signInAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const principal = developmentPrincipalFor(field(form, 'token'));
  if (principal === undefined) return back(`/${locale}`, 'SIGN_IN_REFUSED');
  await startAdminSession(principal);
  redirect(`/${locale}/credentials`);
}

export async function signOutAction(form: FormData): Promise<void> {
  await endAdminSession();
  redirect(`/${field(form, 'locale') || 'ar'}`);
}

export async function saveCredentialAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const tenantCode = field(form, 'tenant');
  const to = `/${locale}/credentials?tenant=${encodeURIComponent(tenantCode)}`;
  if ((await currentAdmin()) === undefined) redirect(`/${locale}`);
  const s = store();
  if (s.kind !== 'READY') back(to, 'NO_DATABASE');
  const provider = field(form, 'provider');
  const environment = field(form, 'environment');
  const keyName = field(form, 'keyName');
  const secret = form.get('secret');
  const label = field(form, 'label');
  if (!(VAULT_PROVIDERS as readonly string[]).includes(provider)) back(to, 'PROVIDER_UNKNOWN');
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) back(to, 'ENVIRONMENT_UNKNOWN');
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(keyName)) back(to, 'KEY_NAME_MALFORMED');
  if (typeof secret !== 'string' || secret.trim().length === 0) back(to, 'SECRET_EMPTY');
  if (s.kind !== 'READY' || typeof secret !== 'string') return;
  try {
    await saveCredential(s.pool, { tenantCode, provider: provider as VaultProvider, environment: environment as Environment, keyName, secret: secret.trim(), ...(label === '' ? {} : { label }) });
  } catch {
    back(to, 'SAVE_FAILED');
  }
  back(to, 'SAVED');
}

export async function revokeCredentialAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const tenantCode = field(form, 'tenant');
  const to = `/${locale}/credentials?tenant=${encodeURIComponent(tenantCode)}`;
  if ((await currentAdmin()) === undefined) redirect(`/${locale}`);
  const s = store();
  if (s.kind !== 'READY') back(to, 'NO_DATABASE');
  const id = field(form, 'credentialId');
  if (!/^[0-9a-f-]{36}$/i.test(id)) back(to, 'CREDENTIAL_ID_MALFORMED');
  if (field(form, 'confirm') !== 'yes') back(to, 'CONFIRMATION_REQUIRED');
  if (s.kind !== 'READY') return;
  try { await revokeCredential(s.pool, id); } catch { back(to, 'REVOKE_FAILED'); }
  back(to, 'REVOKED');
}

const nowEpoch = (): bigint => BigInt(Math.floor(Date.now() / 1000));

export async function proposeProductChangeAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const tenant = field(form, 'tenant');
  const to = `/${locale}/products?tenant=${encodeURIComponent(tenant)}`;
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  if (!isTenantCode(tenant)) return back(to, 'TENANT_UNKNOWN');
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const now = nowEpoch();
  const current = await resolveProductCatalogue(tenant, now);
  if (!current.catalogue.ok) return back(to, 'CATALOGUE_UNREADABLE');
  const effectiveRaw = field(form, 'effectiveFrom');
  const effectiveMs = effectiveRaw === '' ? Date.now() : Date.parse(effectiveRaw);
  if (!Number.isFinite(effectiveMs)) return back(to, 'EFFECTIVE_FROM_MALFORMED');
  const boardRulingRef = field(form, 'boardRulingRef');
  const changed = catalogueWithChange(current.catalogue.value, { productCode: field(form, 'productCode'), enabled: form.get('enabled') === 'on', termsJson: field(form, 'terms'), ...(boardRulingRef === '' ? {} : { boardRulingRef }) });
  if (!changed.ok) return back(to, `REFUSED:${changed.error.reason}`);
  const summary = field(form, 'summary');
  const checked = checkProposal({ tenant, payload: changed.value.payload, summary, effectiveFromEpochSeconds: BigInt(Math.floor(effectiveMs / 1000)), proposedBy: admin?.principalId ?? '', nowEpochSeconds: now });
  if (!checked.ok) return back(to, `REFUSED:${checked.error.reason}`);
  try {
    await proposeRevision(s.pool, { tenantCode: tenant, area: 'PRODUCTS', payload: changed.value.payload, summary, effectiveFromEpochSeconds: BigInt(Math.floor(effectiveMs / 1000)), proposedBy: admin?.principalId ?? '', correlationId: randomUUID() });
  } catch { return back(to, 'PROPOSE_FAILED'); }
  back(to, 'PROPOSED');
}

export async function decideRevisionAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const tenant = field(form, 'tenant');
  const area = field(form, 'area') === 'rails' ? 'rails' : 'products';
  const to = `/${locale}/${area}?tenant=${encodeURIComponent(tenant)}`;
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const id = field(form, 'revisionId');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(to, 'REVISION_ID_MALFORMED');
  const approve = field(form, 'decision') === 'approve';
  const reason = field(form, 'reason');
  if (!approve && reason.length < 3) return back(to, 'REJECTION_REASON_REQUIRED');
  try {
    await decideRevision(s.pool, { id, decidedBy: admin?.principalId ?? '', approve, ...(approve ? {} : { reason }), correlationId: randomUUID() });
  } catch (error) {
    return back(to, /FOUR_EYES/.test(error instanceof Error ? error.message : '') ? 'REFUSED:FOUR_EYES_SELF_DECISION' : 'DECIDE_FAILED');
  }
  back(to, approve ? 'APPROVED' : 'REJECTED');
}

export async function proposeRailChangeAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const tenant = field(form, 'tenant');
  const to = `/${locale}/rails?tenant=${encodeURIComponent(tenant)}`;
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  if (!isTenantCode(tenant)) return back(to, 'TENANT_UNKNOWN');
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const now = nowEpoch();
  const current = await resolveRailsConfiguration(tenant, now);
  if (!current.rails.ok) return back(to, 'RAILS_UNREADABLE');
  const effectiveRaw = field(form, 'effectiveFrom');
  const effectiveMs = effectiveRaw === '' ? Date.now() : Date.parse(effectiveRaw);
  if (!Number.isFinite(effectiveMs)) return back(to, 'EFFECTIVE_FROM_MALFORMED');
  const opt = (name: string): string | undefined => { const v = field(form, name); return v === '' ? undefined : v; };
  const fallback = opt('fallbackAdapter'); const baseUrl = opt('baseUrl'); const note = opt('note');
  const changed = railsWithChange(current.rails.value, { capability: field(form, 'capability'), adapter: field(form, 'adapter'), environment: field(form, 'environment'), enabled: form.get('enabled') === 'on', ...(fallback === undefined ? {} : { fallbackAdapter: fallback }), ...(baseUrl === undefined ? {} : { baseUrl }), ...(note === undefined ? {} : { note }) });
  if (!changed.ok) return back(to, `REFUSED:${changed.error.reason}`);
  const summary = field(form, 'summary');
  const effectiveFromEpochSeconds = BigInt(Math.floor(effectiveMs / 1000));
  const checked = proposePure({ id: randomUUID(), tenantId: tenant, area: 'RAILS', rawPayload: changed.value.payload, summary, effectiveFromEpochSeconds, proposedBy: admin?.principalId ?? '', proposedAtEpochSeconds: now, parse: (raw) => parseRailsConfiguration(raw, ADAPTER_CATALOGUE) });
  if (!checked.ok) return back(to, `REFUSED:${checked.error.reason}`);
  try {
    await proposeRevision(s.pool, { tenantCode: tenant, area: 'RAILS', payload: changed.value.payload, summary, effectiveFromEpochSeconds, proposedBy: admin?.principalId ?? '', correlationId: randomUUID() });
  } catch { return back(to, 'PROPOSE_FAILED'); }
  back(to, 'PROPOSED');
}
