/**
 * Merchants, for the checkout API: who is calling (by token digest, constant
 * time) and whether they may transact (an ACTIVE merchant record).
 * Development registry: tokens from the environment, one seeded merchant.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { type Merchant, beginOnboarding, verify } from '@sanad/core/merchants/merchant.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

import { developmentAttestation } from './store.ts';

export interface MerchantPrincipal {
  readonly merchantId: string;
  readonly tenantId: string;
  readonly credentialRef: string;
}

interface State { readonly merchants: Map<string, Merchant>; readonly tokens: Map<string, MerchantPrincipal> }
const KEY = Symbol.for('sanad.consumer.merchants');
const scope = globalThis as unknown as Record<symbol, State | undefined>;
const digestOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

function seed(): State {
  const merchants = new Map<string, Merchant>();
  const at = developmentAttestation();
  const pending = expectOk(beginOnboarding({ merchantId: 'mer-demo-01', tenantId: 'bank-a', commercialRegistration: '4030000004', legalNameAr: 'متجر التجربة', legalNameEn: 'Demo Store', categoryCode: 'RETAIL_ELECTRONICS', settlementAccountRef: 'hub-acct-ref-demo-01', correlationId: 'seed' }, at));
  merchants.set('mer-demo-01', expectOk(verify(pending, { registryLookupRef: 'wathq-dev-1', registryStatus: 'ACTIVE', screeningResultRef: 'scr-dev-1', screeningOutcome: 'CLEAR', activityPermitted: true, verifiedBy: 'stf-ops-01', verifiedAt: at })));
  const tokens = new Map<string, MerchantPrincipal>();
  const token = process.env['MERCHANT_DEV_TOKEN'];
  if (token !== undefined && token.trim().length > 0) tokens.set(digestOf(token), { merchantId: 'mer-demo-01', tenantId: 'bank-a', credentialRef: 'cred-dev-merchant-01' });
  return { merchants, tokens };
}
const state: State = (scope[KEY] ??= seed());

export function authenticateMerchant(authorization: string | undefined): MerchantPrincipal | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (m === null) return undefined;
  const presented = Buffer.from(digestOf(m[1] ?? ''), 'hex');
  let found: MerchantPrincipal | undefined;
  for (const [digest, principal] of state.tokens) {
    const candidate = Buffer.from(digest, 'hex');
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) found = principal;
  }
  return found;
}

export const merchantById = (merchantId: string): Merchant | undefined => state.merchants.get(merchantId);
