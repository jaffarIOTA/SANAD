/**
 * Staff principals for the internal review API. Development: bearer tokens
 * from the environment mapped to the two workbench identities. Production:
 * the institution's OpenID Connect provider; subject, tenant and approval
 * authority from the token's claims.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { Principal } from '@sanad/core/origination/request.ts';

import { CHECKER, MAKER } from './session.ts';

const digestOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

function registry(): Map<string, Principal> {
  const out = new Map<string, Principal>();
  const add = (token: string | undefined, principal: Principal): void => { if (token !== undefined && token.trim().length > 0) out.set(digestOf(token), principal); };
  add(process.env['STAFF_DEV_TOKEN_CHECKER'], CHECKER);
  add(process.env['STAFF_DEV_TOKEN_MAKER'], MAKER);
  add(process.env['STAFF_DEV_TOKEN_SENIOR'], { principalId: 'stf-senior-01', tenantId: 'bank-a', authority: 'SENIOR_CHECKER' });
  return out;
}
const REGISTRY = registry();

export function authenticateStaff(authorization: string | undefined): Principal | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (m === null) return undefined;
  const presented = Buffer.from(digestOf(m[1] ?? ''), 'hex');
  let found: Principal | undefined;
  for (const [digest, principal] of REGISTRY) {
    const candidate = Buffer.from(digest, 'hex');
    if (candidate.length === presented.length && timingSafeEqual(candidate, presented)) found = principal;
  }
  return found;
}
