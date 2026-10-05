/**
 * Merchants, for the checkout API: who is calling (by token digest, constant
 * time) and whether they may transact (an ACTIVE merchant record).
 *
 * With a database the record is read from `core.merchant` on every call, so a
 * merchant the workbench suspends is refused at the next checkout request. An
 * empty table is seeded with the development merchant, through the domain's
 * own onboarding and verification. Without a database the development
 * merchant lives in this process's memory, as before.
 *
 * Credentials are development tokens from the environment; production maps a
 * gateway-authenticated client to a merchant.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { type Merchant, beginOnboarding, verify } from '@sanad/core/merchants/merchant.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { loadMerchants, saveMerchant } from '@sanad/origination/merchants.ts';

import { persistencePool } from './persistence.ts';
import { developmentAttestation } from './store.ts';

export interface MerchantPrincipal {
  readonly merchantId: string;
  readonly tenantId: string;
  readonly credentialRef: string;
}

const TENANT_CODE = 'bank-a';

interface State { readonly merchants: Map<string, Merchant>; readonly tokens: Map<string, MerchantPrincipal>; seededDatabase?: boolean }
const KEY = Symbol.for('sanad.consumer.merchants');
const scope = globalThis as unknown as Record<symbol, State | undefined>;
const digestOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** The development merchant, made the way any merchant is: onboarded by one person, verified by another, under a contract. */
function developmentMerchant(): Merchant {
  const at = developmentAttestation();
  const pending = expectOk(beginOnboarding({ merchantId: 'mer-demo-01', tenantId: TENANT_CODE, commercialRegistration: '4030000004', legalNameAr: 'متجر التجربة', legalNameEn: 'Demo Store', categoryCode: 'RETAIL_ELECTRONICS', settlementAccountRef: 'hub-acct-ref-demo-01', onboardedBy: 'stf-maker-01', correlationId: 'seed' }, at));
  return expectOk(verify(pending, { agreementRef: 'AGR-DEV-0001', registryLookupRef: 'registry-dev-1', registryStatus: 'ACTIVE', screeningResultRef: 'scr-dev-1', screeningOutcome: 'CLEAR', activityPermitted: true, verifiedBy: 'stf-checker-01', verifiedAt: at }));
}

function initial(): State {
  const merchants = new Map<string, Merchant>();
  // Without a database the development merchant is seeded here; with one, `refreshMerchants()` reads it from there.
  if (persistencePool() === undefined) merchants.set('mer-demo-01', developmentMerchant());
  const tokens = new Map<string, MerchantPrincipal>();
  const token = process.env['MERCHANT_DEV_TOKEN'];
  if (token !== undefined && token.trim().length > 0) tokens.set(digestOf(token), { merchantId: 'mer-demo-01', tenantId: TENANT_CODE, credentialRef: 'cred-dev-merchant-01' });
  return { merchants, tokens };
}
const state: State = (scope[KEY] ??= initial());

/** Reads the merchants from the database. Called before the checkout API decides whether a merchant may transact. */
export async function refreshMerchants(): Promise<void> {
  const pool = persistencePool();
  if (pool === undefined) return;
  let merchants = await loadMerchants(pool, TENANT_CODE);
  if (merchants.length === 0 && state.seededDatabase !== true) {
    const demo = developmentMerchant();
    await saveMerchant(pool, TENANT_CODE, { merchant: demo, event: 'MERCHANT_SEEDED_FOR_DEVELOPMENT', actor: 'development', correlationId: demo.core.correlationId });
    merchants = [demo];
  }
  state.seededDatabase = true;
  state.merchants.clear();
  for (const m of merchants) state.merchants.set(m.core.merchantId, m);
}

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
