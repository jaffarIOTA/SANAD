/**
 * Wathq — business registry adapter (CLAUDE.md §5).
 *
 * Implements the business-registry port: a lookup by commercial registration
 * against the Ministry of Commerce data. Signatory identifiers are dropped at
 * this boundary; the record carries references only.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { BusinessRegistryPort, RegistrationRecord } from '../../../core/ports/business-registry.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, decimalToMinor, epoch, malformed, str } from '../kernel/rail-adapter.ts';

export const WATHQ_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'WATHQ-DEV-002',
    summary: 'The registry returns the signatories’ national identifiers.',
    containment: 'Identifiers are dropped at this boundary; the record carries opaque signatory references only.',
    verificationRef: 'KSA-RAIL-WATHQ-01',
  },
];

const STATUS: Readonly<Record<string, RegistrationRecord['status']>> = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
};

export class WathqAdapter extends RailAdapter implements BusinessRegistryPort {
  readonly vendorName = 'Wathq';
  readonly capabilities = ['BUSINESS_REGISTRY'] as const;
  readonly deviations = WATHQ_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async lookup(p: {
    readonly tenantId: string;
    readonly commercialRegistration: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<RegistrationRecord>>> {
    if (!/^\d{10}$/.test(p.commercialRegistration))
      return reject('OP-DETERMINACY', 'CR_MALFORMED', 'A commercial registration number is ten digits');
    const r = await this.invoke(
      'registry.lookup',
      { method: 'GET', path: `/v1/commercial-registrations/${p.commercialRegistration}` },
      p.correlationId,
    );
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED', code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    const nameAr = str(v['nameAr']);
    const nameEn = str(v['nameEn']);
    const legalForm = str(v['legalForm']);
    const status = STATUS[String(v['status'])];
    const lookupRef = str(v['lookupId']) ?? `wathq-${p.commercialRegistration}`;
    const at = epoch(v['asOf']);
    if (
      nameAr === undefined ||
      nameEn === undefined ||
      legalForm === undefined ||
      status === undefined ||
      at === undefined
    )
      return ok(malformed());
    const signatoryRefs = Array.isArray(v['signatories'])
      ? (v['signatories'] as unknown[]).flatMap((s) => {
          const ref = str((s as Record<string, unknown>)['ref']);
          return ref === undefined ? [] : [ref];
        })
      : [];
    const activityCodes = Array.isArray(v['activities'])
      ? (v['activities'] as unknown[]).flatMap((a) => {
          const code = str((a as Record<string, unknown>)['code']);
          return code === undefined ? [] : [code];
        })
      : [];
    const capital = decimalToMinor(v['paidCapital']);
    const registered = str(v['registeredAt']);
    return ok({
      kind: 'ANSWERED',
      value: {
        commercialRegistration: p.commercialRegistration,
        legalNameAr: nameAr,
        legalNameEn: nameEn,
        legalForm,
        status,
        activityCodes,
        signatoryRefs,
        lookupRef,
        retrievedAtEpochSeconds: at,
        ...(capital === undefined ? {} : { paidCapitalMinorUnits: capital }),
        ...(registered === undefined ? {} : { registeredAtGregorian: registered }),
      },
    });
  }
}
