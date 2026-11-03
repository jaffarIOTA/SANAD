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
 * consumer loan is refused as unavailable, except where a synthetic
 * demonstration is permitted: there a live sandbox gets a labelled synthetic
 * person, and the demonstration transport a labelled stand-in. Neither is a
 * real identifier.
 */
import { createHash, randomUUID } from 'node:crypto';

import { type LoanBookingConfig, type TenantCode, loadTenantJurisdiction } from '../../../config/loader.ts';
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

/**
 * A live loan system's sandbox, where no identity store is connected: a synthetic person, labelled as one,
 * with the party-master fields the sandbox requires (adapters/tuum/README.md, KBNPL run 2026-11-03). Only
 * where a synthetic demonstration is permitted, so never against a database that may hold customer data.
 */
const sandboxIdentity =
  (country: string): RestrictedAttributesResolver =>
  (ref) =>
    Promise.resolve({
      idNumber: `SANAD-TEST-${createHash('sha256').update(ref).digest('hex').slice(0, 12).toUpperCase()}`,
      idCountryCode: country,
      givenName: 'Sanad',
      surname: 'Synthetic Customer',
      birthDate: '1990-01-01',
      sex: 'M',
      nationality: country,
      residencyCountryCode: country,
      address: {
        street1: 'Synthetic Street 1',
        cityCounty: country === 'AE' ? 'Dubai' : 'Riyadh',
        zip: '00000',
        countryCode: country,
      },
    });

/** Who a live consumer booking is for: the identity store when one is connected; a synthetic person in a sandbox. */
async function liveIdentity(
  tenant: TenantCode,
  pool: Pool | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<RestrictedAttributesResolver> {
  if (!(await syntheticDemonstrationPermitted(pool, env))) return noIdentityStore;
  const jurisdiction = loadTenantJurisdiction(tenant);
  return jurisdiction.ok ? sandboxIdentity(jurisdiction.value.code) : noIdentityStore;
}

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
    // The same spellings the Admin product catalogue accepts: the vault keeps the name as it was saved.
    readKey(tenant, 'tenant_code').then(
      async (v) => v ?? (await readKey(tenant, 'tenantcode')) ?? (await readKey(tenant, 'tenantCode')),
    ),
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
        : { accountSetup: config.servicingAccount, restricted: await liveIdentity(tenant, pool, env) },
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
