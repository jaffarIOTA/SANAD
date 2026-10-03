'use server';

/**
 * The administration actions. Plain form posts and redirects. The secret
 * field is read once and handed to the store; it is not echoed into a
 * redirect, a log or an error.
 */

import { redirect } from 'next/navigation';

import { ENVIRONMENTS, type Environment, VAULT_PROVIDERS, type VaultProvider, revokeCredential, saveCredential, store } from './credentials.ts';
import { acceptsDevelopmentToken, currentAdmin, endAdminSession, startAdminSession } from './session.ts';

const field = (form: FormData, name: string): string => { const v = form.get(name); return typeof v === 'string' ? v.trim() : ''; };
const back = (to: string, notice: string): never => redirect(`${to}${to.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`);

export async function signInAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const token = field(form, 'token');
  if (!acceptsDevelopmentToken(token)) back(`/${locale}`, 'SIGN_IN_REFUSED');
  await startAdminSession('adm-dev-01');
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
