/**
 * The institution's loan system, for booking and servicing loans (UAE M6; BNPL booking and servicing).
 *
 * Which loan system: the tenant's configuration names the adapter
 * (config/tenants/<t>/core-banking/loan-products.json). Which transport:
 * - live, when the vault holds the tenant's CORE_BANKING credentials and, to
 *   opt in, the person API host (`person_api_base_url`) as well;
 * - otherwise, only where a synthetic demonstration is permitted, the
 *   demonstration transport, labelled Fixture;
 * - otherwise none, and the caller refuses as unavailable.
 *
 * A consumer loan's borrower is a natural person whose national identifier
 * Sanad never holds (CLAUDE.md §2). The loan system's party master needs one;
 * it is resolved from the institution's identity store inside the adapter
 * (TUUM-DEV-002). No identity store is connected yet, so a live booking of a
 * consumer loan is refused as unavailable; the demonstration resolves a
 * labelled stand-in that is not a real identifier.
 */
import { randomUUID } from 'node:crypto';

import type { LoanBookingConfig, TenantCode } from '../../../config/loader.ts';
import type { LoanBookingPort } from '../../../core/ports/loan-booking.ts';
import type { LoanServicingPort } from '../../../core/ports/loan-servicing.ts';
import { HttpTransport } from '../../../adapters/kernel/http-transport.ts';
import { createTuumSession, fetchAuthHttp } from '../../../adapters/tuum/authentication.ts';
import { TuumDemonstrationTransport, demonstrationSession } from '../../../adapters/tuum/demonstration.ts';
import { type RestrictedAttributesResolver, TuumLendingAdapter } from '../../../adapters/tuum/lending-adapter.ts';
import { credentialProviderFromEnvironment } from './credentials.ts';
import { syntheticDemonstrationPermitted } from './profile.ts';
import type { Pool } from 'pg';

export type LoanSystem = LoanBookingPort & LoanServicingPort;

async function readKey(tenant: TenantCode, keyName: string): Promise<string | undefined> {
  try {
    return (
      await credentialProviderFromEnvironment().get(
        { tenantId: tenant, provider: 'CORE_BANKING', environment: 'sandbox', keyName },
        randomUUID(),
      )
    ).expose();
  } catch {
    return undefined;
  }
}

/** No identity store is connected: a live consumer booking cannot resolve the borrower's identifier. */
const noIdentityStore: RestrictedAttributesResolver = () => Promise.resolve(undefined);

/** The demonstration's stand-in: labelled, derived from the pointer, never a real identifier. */
const demonstrationIdentity: RestrictedAttributesResolver = (ref) =>
  Promise.resolve({ idNumber: `DEMO-${ref}`, idTypeCode: 'DEMO', givenName: 'Demonstration', surname: 'Customer' });

export async function loanSystemFor(
  tenant: TenantCode,
  config: LoanBookingConfig,
  pool: Pool | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LoanSystem | undefined> {
  if (config.adapter !== 'TUUM') return undefined;
  const [auth, person, loan, account, username, tenantCode] = await Promise.all([
    readKey(tenant, 'auth_base_url'),
    readKey(tenant, 'person_api_base_url'),
    readKey(tenant, 'loan_api_base_url'),
    readKey(tenant, 'account_api_base_url'),
    readKey(tenant, 'username'),
    readKey(tenant, 'tenant_code'),
  ]);
  if (
    auth !== undefined &&
    person !== undefined &&
    loan !== undefined &&
    username !== undefined &&
    tenantCode !== undefined
  ) {
    const session = createTuumSession({
      baseUrl: auth.replace(/\/+$/, ''),
      http: fetchAuthHttp(),
      // The password is read through the audited vault function at each login, never kept.
      credentials: async () => ({
        username,
        tenantCode,
        identityKind: 'EMPLOYEE',
        password: (await readKey(tenant, 'password')) ?? '',
      }),
      nowEpochSeconds: () => Math.floor(Date.now() / 1000),
    });
    return new TuumLendingAdapter(
      {
        person: person.replace(/\/+$/, ''),
        loan: loan.replace(/\/+$/, ''),
        ...(account === undefined ? {} : { account: account.replace(/\/+$/, '') }),
      },
      session,
      new HttpTransport(),
      tenantCode,
      'LIVE',
      config.servicingAccount === undefined
        ? undefined
        : { accountSetup: config.servicingAccount, restricted: noIdentityStore },
    );
  }
  if (await syntheticDemonstrationPermitted(pool, env))
    return new TuumLendingAdapter(
      {
        person: 'https://person.demonstration.invalid',
        loan: 'https://lending.demonstration.invalid',
        account: 'https://account.demonstration.invalid',
      },
      demonstrationSession,
      new TuumDemonstrationTransport(),
      'DEMO',
      'FIXTURE',
      config.servicingAccount === undefined
        ? undefined
        : { accountSetup: config.servicingAccount, restricted: demonstrationIdentity },
    );
  return undefined;
}
