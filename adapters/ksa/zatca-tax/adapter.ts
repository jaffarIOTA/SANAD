/**
 * ZATCA — tax compliance adapter (CLAUDE.md §5).
 *
 * Implements the TaxCompliancePort. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 *
 * Assumed contract (no published API — see README.md): the fields of ZATCA's
 * public zakat / tax certificate inquiry e-service, searched by commercial
 * registration (or TIN): certificate number, certificate type, status, issue
 * date and expiry date, and the taxpayer it was issued to.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, idStr, isoToEpoch, malformed, obj, own } from '../kernel/rail-adapter.ts';
import type { TaxCompliancePort } from '../../../core/ports/tax-compliance.ts';

export const ZATCATAXADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'ZATCA-TAX-DEV-001',
    summary: 'Certificate status vocabulary is the authority’s own and is published only as screen text.',
    containment:
      'Mapped to VALID / EXPIRED / NOT_FOUND / SUSPENDED by an own-key lookup at this boundary; an unknown status is UNAVAILABLE, never VALID. A certificate whose expiry date has passed is EXPIRED whatever its status says.',
    verificationRef: 'KSA-RAIL-ZATCA-02',
  },
];

type CertificateStatus = 'VALID' | 'EXPIRED' | 'NOT_FOUND' | 'SUSPENDED';

export class ZatcaTaxAdapter extends RailAdapter implements TaxCompliancePort {
  readonly vendorName = 'ZATCA';
  readonly capabilities = ['TAX_COMPLIANCE'] as const;
  readonly deviations = ZATCATAXADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  /** The e-service's certificate status ("Valid" / "Expired" / …) to the port. Read with `own`, never by index. */
  static readonly STATUS: Readonly<Record<string, CertificateStatus>> = {
    VALID: 'VALID',
    ACTIVE: 'VALID',
    EXPIRED: 'EXPIRED',
    SUSPENDED: 'SUSPENDED',
    REVOKED: 'SUSPENDED',
    CANCELLED: 'SUSPENDED',
  };

  async certificateStatus(p: { readonly tenantId: string; readonly crNumber: string; readonly correlationId: string }) {
    const r = await this.invoke(
      'tax.certificate',
      { method: 'GET', path: `/zatca/v1/zakat-certificates?crNumber=${encodeURIComponent(p.crNumber)}` },
      p.correlationId,
    );
    const now = BigInt(this.config.nowEpochSeconds());
    // No certificate on record is an answer the port can carry, not a failure.
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404')
      return ok({ kind: 'ANSWERED' as const, value: { status: 'NOT_FOUND' as const, retrievedAtEpochSeconds: now } });
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    // Own keys only: a status of "constructor" is not understood, not Object.prototype.constructor.
    const stated = own(ZatcaTaxAdapter.STATUS, v['status']);
    const certificateRef = idStr(v['certificateNumber']);
    if (stated === undefined || certificateRef === undefined) return ok(malformed());
    // The certificate must be about the registration asked for.
    const holderCr = idStr(obj(v['taxpayer'])?.['crNumber']);
    if (holderCr !== undefined && holderCr !== p.crNumber) return ok(malformed());
    const until = v['expiryDate'] === undefined ? undefined : isoToEpoch(v['expiryDate']);
    if (v['expiryDate'] !== undefined && until === undefined) return ok(malformed());
    const status: CertificateStatus = stated === 'VALID' && until !== undefined && until < now ? 'EXPIRED' : stated;
    return ok({
      kind: 'ANSWERED' as const,
      value: {
        status,
        retrievedAtEpochSeconds: now,
        certificateRef,
        ...(until === undefined ? {} : { validUntilEpochSeconds: until }),
      },
    });
  }
}
