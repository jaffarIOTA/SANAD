/**
 * The KYB rails an intake calls: the business registry, identity verification
 * and screening, as ports (CLAUDE.md §5). Which implementation stands behind
 * them is decided here and nowhere else:
 *
 *   - where a synthetic demonstration is permitted (the process declares
 *     synthetic data and the database confirms it, or development), the real
 *     UAE adapters run over the demonstration transport and the screening
 *     stand-in, and every answer is labelled FIXTURE;
 *   - anywhere else the rails are UNAVAILABLE until each has made a verified
 *     sandbox call (its adapter README's verification item). A rail that is
 *     down never approves anything: the intake simply cannot complete KYB.
 *
 * The adapters verify each consent themselves against the consent ledger
 * before calling out (SR-026), so the ledger passed in is the tenant's own.
 */
import type { CredentialProvider, CredentialRef } from '@sanad/core/ports/credentials.ts';
import { SecretValue } from '@sanad/core/ports/credentials.ts';
import type { BusinessRegistryPort } from '@sanad/core/ports/business-registry.ts';
import type { ConsentLedger } from '@sanad/core/ports/consent-ledger.ts';
import type { IdentityVerificationPort } from '@sanad/core/ports/identity-verification.ts';
import type { ScreeningPort } from '@sanad/core/ports/screening.ts';
import type { AccountInformationPort } from '@sanad/core/ports/account-information.ts';
import type { CreditBureauPort } from '@sanad/core/ports/credit-bureau.ts';
import type { TaxCompliancePort } from '@sanad/core/ports/tax-compliance.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import type { RailAdapterConfig } from '../../../../adapters/kernel/rail-adapter.ts';
import { DemonstrationScreening } from '../../../../adapters/screening/demonstration/adapter.ts';
import { DemonstrationTransport } from '../../../../adapters/uae/demonstration/transport.ts';
import { AecbAdapter } from '../../../../adapters/uae/aecb/adapter.ts';
import { FtaAdapter } from '../../../../adapters/uae/fta/adapter.ts';
import { IcpAdapter } from '../../../../adapters/uae/icp/adapter.ts';
import { OpenFinanceAdapter } from '../../../../adapters/uae/open-finance/adapter.ts';
import { NerAdapter } from '../../../../adapters/uae/ner/adapter.ts';
import { KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { OpenBankingAdapter } from '../../../../adapters/ksa/open-banking/adapter.ts';
import { SimahAdapter } from '../../../../adapters/ksa/simah/adapter.ts';
import { WathqAdapter } from '../../../../adapters/ksa/wathq/adapter.ts';
import { YakeenAdapter } from '../../../../adapters/ksa/yakeen/adapter.ts';
import { ZatcaTaxAdapter } from '../../../../adapters/ksa/zatca-tax/adapter.ts';
import { loadTenantOnboarding, isTenantCode } from '@sanad/config/loader.ts';
import { persistencePool } from './persistence.ts';

export interface KybRails {
  readonly registry: BusinessRegistryPort;
  readonly identity: IdentityVerificationPort;
  readonly screening: ScreeningPort;
  /** The tax authority, for the TRN check at intake. */
  readonly tax: TaxCompliancePort;
  /** The credit bureau, for the commercial report at credit assessment. */
  readonly bureau: CreditBureauPort;
  /** Open Finance account information, for the bank-statement facts at credit assessment. */
  readonly accounts: AccountInformationPort;
  readonly source: 'LIVE' | 'FIXTURE';
  /**
   * Whose rails these are. The tax check differs: the UAE's checks a tax
   * registration number with the tax authority; Saudi Arabia's checks the
   * zakat certificate by commercial registration.
   */
  readonly jurisdiction: 'AE' | 'SA';
}

/** The tenant's jurisdiction, from its onboarding (ADR 0005). */
export function tenantJurisdiction(tenantId: string): 'AE' | 'SA' | undefined {
  if (!isTenantCode(tenantId)) return undefined;
  const o = loadTenantOnboarding(tenantId);
  return o.ok && (o.value.jurisdiction === 'AE' || o.value.jurisdiction === 'SA') ? o.value.jurisdiction : undefined;
}

/**
 * The demonstration transport needs no credential, but the adapters ask for one
 * exactly as they will of the vault; this answers that request with a value that
 * reaches nothing and says what it is.
 */
export class DemonstrationCredentials implements CredentialProvider {
  get(_ref: CredentialRef): Promise<SecretValue> {
    return Promise.resolve(new SecretValue('demonstration-transport-needs-no-credential'));
  }
}

export function demonstrationConfig(
  tenantId: string,
  provider: RailAdapterConfig['provider'],
  consents: ConsentLedger,
  now: () => number,
): RailAdapterConfig {
  return {
    tenantId,
    provider,
    environment: 'sandbox',
    freshnessWindowSeconds: 0,
    failurePosture: 'FAIL_CLOSED',
    credentialTtlSeconds: 600,
    breaker: { failureThreshold: 3, resetAfterSeconds: 30, successThreshold: 1 },
    nowEpochSeconds: now,
    baseUrl: 'https://demonstration.invalid',
    consents,
  };
}

/** The tenant's KYB rails, or undefined where none may run (the screen then says the rails are unavailable). */
export async function kybRails(
  tenantId: string,
  consents: ConsentLedger,
  attest: () => Promise<TsaInstant>,
  now: () => number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<KybRails | undefined> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(env), env))) return undefined;
  const credentials = new DemonstrationCredentials();
  const jurisdiction = tenantJurisdiction(tenantId);
  if (jurisdiction === 'SA') {
    // Saudi Arabia: Wathq (commercial register), Yakeen (identity), ZATCA (zakat certificate by CR), SIMAH, Open Banking.
    const ksa = new KsaDemonstrationTransport(now);
    return {
      registry: new WathqAdapter(demonstrationConfig(tenantId, 'BUSINESS_REGISTRY', consents, now), credentials, ksa),
      identity: new YakeenAdapter(demonstrationConfig(tenantId, 'IDENTITY_VERIFICATION', consents, now), credentials, ksa),
      screening: new DemonstrationScreening(consents, attest),
      tax: new ZatcaTaxAdapter(demonstrationConfig(tenantId, 'TAX_COMPLIANCE', consents, now), credentials, ksa),
      bureau: new SimahAdapter(demonstrationConfig(tenantId, 'CREDIT_BUREAU', consents, now), credentials, ksa, attest),
      accounts: new OpenBankingAdapter(demonstrationConfig(tenantId, 'OPEN_BANKING', consents, now), credentials, ksa),
      source: 'FIXTURE',
      jurisdiction: 'SA',
    };
  }
  if (jurisdiction !== 'AE') return undefined;
  const transport = new DemonstrationTransport(now);
  return {
    registry: new NerAdapter(demonstrationConfig(tenantId, 'BUSINESS_REGISTRY', consents, now), credentials, transport),
    identity: new IcpAdapter(
      demonstrationConfig(tenantId, 'IDENTITY_VERIFICATION', consents, now),
      credentials,
      transport,
    ),
    screening: new DemonstrationScreening(consents, attest),
    tax: new FtaAdapter(demonstrationConfig(tenantId, 'TAX_COMPLIANCE', consents, now), credentials, transport),
    bureau: new AecbAdapter(
      demonstrationConfig(tenantId, 'CREDIT_BUREAU', consents, now),
      credentials,
      transport,
      attest,
    ),
    accounts: new OpenFinanceAdapter(
      // The vault names the credential by capability: a UAE tenant's Open Finance credential is its OPEN_BANKING one.
      demonstrationConfig(tenantId, 'OPEN_BANKING', consents, now),
      credentials,
      transport,
    ),
    source: 'FIXTURE',
    jurisdiction: 'AE',
  };
}
