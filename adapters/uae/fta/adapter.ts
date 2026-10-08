/**
 * FTA — tax compliance adapter (ADR 0005).
 *
 * Implements the TaxCompliancePort against the Federal Tax Authority: the
 * business's tax registration and, where issued, its tax residency or
 * registration certificate status. The port's key is named `crNumber`; a
 * fifteen-digit value is a Tax Registration Number, anything else is the
 * trade licence number (FTA-DEV-001).
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { TaxCompliancePort } from '../../../core/ports/tax-compliance.ts';
import { ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, epoch, malformed, str } from '../../kernel/rail-adapter.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const FTA_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'FTA-DEV-001',
    summary: 'The authority keys a taxpayer on its Tax Registration Number (fifteen digits); the port field is named crNumber.',
    containment: 'A fifteen-digit value is sent as the TRN, anything else as the trade licence for the authority to resolve. The port is not renamed; the naming debt is recorded against ADR 0005.',
    verificationRef: 'UAE-RAIL-FTA-01',
  },
  {
    id: 'FTA-DEV-002',
    summary: 'Registration status vocabulary is the authority’s own, and an unregistered business may simply be below the registration threshold.',
    containment: 'Mapped to VALID / EXPIRED / NOT_FOUND / SUSPENDED here; an unknown status is UNAVAILABLE, never VALID. Whether NOT_FOUND matters is the tenant’s credit policy, not this adapter’s.',
    verificationRef: 'UAE-RAIL-FTA-01',
  },
];

type TaxStatus = 'VALID' | 'EXPIRED' | 'NOT_FOUND' | 'SUSPENDED';
const STATUS: Readonly<Record<string, TaxStatus>> = { REGISTERED: 'VALID', ACTIVE: 'VALID', DEREGISTERED: 'EXPIRED', EXPIRED: 'EXPIRED', NOT_REGISTERED: 'NOT_FOUND', SUSPENDED: 'SUSPENDED' };

const TRN = /^\d{15}$/;
const LICENCE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/-]{2,29}$/;

export class FtaAdapter extends RailAdapter implements TaxCompliancePort {
  readonly vendorName = 'FTA';
  readonly capabilities = ['TAX_COMPLIANCE'] as const;
  readonly deviations = FTA_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async certificateStatus(p: { readonly tenantId: string; readonly crNumber: string; readonly correlationId: string }) {
    const key = p.crNumber.trim();
    let query: string;
    if (TRN.test(key)) query = `trn=${key}`;
    else if (LICENCE_SHAPE.test(key)) query = `licence=${encodeURIComponent(key)}`;
    else return reject('OP-DETERMINACY', 'TAX_KEY_MALFORMED', 'A tax registration number is fifteen digits; a trade licence number is 3 to 30 letters, digits, hyphens or slashes');
    const r = await this.invoke('tax.registration', { method: 'GET', path: `/v1/registrations?${query}` }, p.correlationId);
    // An unknown taxpayer the authority answers for is NOT_FOUND in the body; a bare 404 is a refusal, as with the registry.
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED' as const, code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const status = lookupStatus(STATUS, r.value['registrationStatus']); const at = epoch(r.value['asOf']);
    if (status === undefined || at === undefined) return ok(malformed());
    const ref = str(r.value['certificateNumber']); const until = epoch(r.value['validUntil']);
    return ok({ kind: 'ANSWERED' as const, value: { status, retrievedAtEpochSeconds: at, ...(ref === undefined ? {} : { certificateRef: ref }), ...(until === undefined ? {} : { validUntilEpochSeconds: until }) } });
  }
}
