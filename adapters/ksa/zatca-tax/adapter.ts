/**
 * ZATCA — tax compliance adapter (CLAUDE.md §5).
 *
 * Implements the TaxCompliancePort port. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { Result } from '../../../core/kernel/result.ts';
import { ok } from '../../../core/kernel/result.ts';
import { money } from '../../../core/kernel/money.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, bool, decimalToMinor, epoch, int, malformed, str } from '../kernel/rail-adapter.ts';
import type { TaxCompliancePort } from '../../../core/ports/tax-compliance.ts';

export const ZATCATAXADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'ZATCA-TAX-DEV-001',
    summary: 'Certificate status vocabulary is the authority’s own.',
    containment: 'Mapped to VALID / EXPIRED / NOT_FOUND / SUSPENDED at this boundary; an unknown status is UNAVAILABLE, never VALID.',
    verificationRef: 'KSA-RAIL-ZATCA-02',
  },
];

export class ZatcaTaxAdapter extends RailAdapter implements TaxCompliancePort {
  readonly vendorName = 'ZATCA';
  readonly capabilities = ['TAX_COMPLIANCE'] as const;
  readonly deviations = ZATCATAXADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  static readonly STATUS: Readonly<Record<string, 'VALID' | 'EXPIRED' | 'NOT_FOUND' | 'SUSPENDED'>> = { ACTIVE: 'VALID', VALID: 'VALID', EXPIRED: 'EXPIRED', NOT_FOUND: 'NOT_FOUND', SUSPENDED: 'SUSPENDED' };

  async certificateStatus(p: { readonly tenantId: string; readonly crNumber: string; readonly correlationId: string }) {
    const r = await this.invoke('tax.certificate', { method: 'GET', path: `/v1/certificates?cr=${encodeURIComponent(p.crNumber)}` }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const status = ZatcaTaxAdapter.STATUS[String(r.value['status'])]; const at = epoch(r.value['asOf']);
    if (status === undefined || at === undefined) return ok(malformed());
    const ref = str(r.value['certificateNumber']); const until = epoch(r.value['validUntil']);
    return ok({ kind: 'ANSWERED' as const, value: { status, retrievedAtEpochSeconds: at, ...(ref === undefined ? {} : { certificateRef: ref }), ...(until === undefined ? {} : { validUntilEpochSeconds: until }) } });
  }
}
