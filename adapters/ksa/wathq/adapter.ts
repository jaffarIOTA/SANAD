/**
 * Wathq — business registry adapter (CLAUDE.md §5).
 *
 * Answers the registry half of the counterparty-registry port: a lookup by
 * commercial registration against the Ministry of Commerce data. The other
 * half of that port — the institution's own counterparty master (get by id,
 * begin onboarding) — is not this rail's, and this adapter says so with a
 * typed refusal rather than pretending; splitting the port is recorded as a
 * deviation so it is done deliberately.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { CounterpartyProfile, CounterpartyRegistryPort } from '../../../core/ports/counterparty-registry.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, str } from '../kernel/rail-adapter.ts';

export const WATHQ_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'WATHQ-DEV-001',
    summary: 'The counterparty-registry port mixes the national registry with the institution’s own counterparty master.',
    containment: 'This adapter answers only findByRegistration; get() and beginOnboarding() are refused with COUNTERPARTY_MASTER_NOT_THIS_RAIL so a caller cannot mistake a registry lookup for onboarding. The port is to be split into business-registry and counterparty-master.',
    verificationRef: 'KSA-RAIL-WATHQ-01',
  },
  {
    id: 'WATHQ-DEV-002',
    summary: 'The registry returns the signatories’ national identifiers.',
    containment: 'Identifiers are dropped at this boundary; the profile carries opaque signatory references only.',
    verificationRef: 'KSA-RAIL-WATHQ-01',
  },
];

export class WathqAdapter extends RailAdapter implements CounterpartyRegistryPort {
  readonly vendorName = 'Wathq';
  readonly capabilities = ['BUSINESS_REGISTRY'] as const;
  readonly deviations = WATHQ_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async findByRegistration(tenantId: string, commercialRegistration: string): Promise<Result<CounterpartyProfile | undefined>> {
    if (!/^\d{10}$/.test(commercialRegistration)) return reject('OP-DETERMINACY', 'CR_MALFORMED', 'A commercial registration number is ten digits');
    const r = await this.invoke('registry.lookup', { method: 'GET', path: `/v1/commercial-registrations/${commercialRegistration}` }, `registry-${commercialRegistration.slice(-4)}`);
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok(undefined);
    if (r.kind !== 'ANSWERED') return reject('OP-DETERMINACY', 'REGISTRY_UNAVAILABLE', 'The business registry did not answer', { reason: r.kind === 'UNAVAILABLE' ? r.reason : r.code });
    const nameAr = str(r.value['nameAr']); const nameEn = str(r.value['nameEn']); const legalForm = str(r.value['legalForm']); const status = str(r.value['status']);
    if (nameAr === undefined || nameEn === undefined || legalForm === undefined || status === undefined) return reject('OP-DETERMINACY', 'REGISTRY_RESPONSE_MALFORMED', 'The registry response was not understood');
    const signatoryRefs = Array.isArray(r.value['signatories']) ? (r.value['signatories'] as unknown[]).flatMap((s) => { const ref = str((s as Record<string, unknown>)['ref']); return ref === undefined ? [] : [ref]; }) : [];
    return ok({
      counterpartyId: '', // not the registry's to assign; the master allocates one at onboarding
      tenantId,
      commercialRegistration,
      legalNameAr: nameAr,
      legalNameEn: nameEn,
      legalForm,
      segment: str(r.value['activityClass']) ?? 'UNCLASSIFIED',
      status: status === 'ACTIVE' ? 'ACTIVE' : status === 'SUSPENDED' ? 'SUSPENDED' : 'CLOSED',
      signatoryRefs,
      kycStatus: 'PENDING',
    });
  }

  get(): Promise<Result<CounterpartyProfile>> {
    return Promise.resolve(reject('OP-DETERMINACY', 'COUNTERPARTY_MASTER_NOT_THIS_RAIL', 'The national registry does not hold the institution’s counterparty master (WATHQ-DEV-001)'));
  }

  beginOnboarding(): Promise<Result<{ readonly counterpartyId: string }>> {
    return Promise.resolve(reject('OP-DETERMINACY', 'COUNTERPARTY_MASTER_NOT_THIS_RAIL', 'Onboarding belongs to the institution’s counterparty master (WATHQ-DEV-001)'));
  }
}
