/**
 * Tahaqoq — document verification adapter (CLAUDE.md §5).
 *
 * Implements the DocumentVerificationPort port. Vendor vocabulary stops here: the port sees
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
import type { DocumentVerificationPort } from '../../../core/ports/document-verification.ts';

export const TAHAQOQADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'TAHAQOQ-DEV-001',
    summary: 'The exact service scope (which document classes, which issuers) is unconfirmed.',
    containment: 'The adapter accepts a document type by our own code and maps it through a table that is provisional until the provider confirms; an unmapped type is refused before any call.',
    verificationRef: 'KSA-RAIL-TAHAQOQ-01',
  },
];

export class TahaqoqAdapter extends RailAdapter implements DocumentVerificationPort {
  readonly vendorName = 'Tahaqoq';
  readonly capabilities = ['DOCUMENT_VERIFICATION'] as const;
  readonly deviations = TAHAQOQADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  static readonly DOCUMENT_TYPES: Readonly<Record<string, string>> = { COMMERCIAL_REGISTRATION: 'CR', ZAKAT_CERTIFICATE: 'ZAKAT', NATIONAL_ADDRESS: 'ADDRESS' };

  async verifyDocument(p: { readonly tenantId: string; readonly applicantRef: string; readonly documentType: string; readonly documentRef: string; readonly consentId: string; readonly correlationId: string }) {
    const consent = this.requireConsent(p.consentId); if (!consent.ok) return consent;
    const vendorType = TahaqoqAdapter.DOCUMENT_TYPES[p.documentType];
    if (vendorType === undefined) return ok({ kind: 'REFUSED' as const, code: 'DOCUMENT_TYPE_UNSUPPORTED' });
    const r = await this.invoke('document.verify', { method: 'POST', path: '/v1/verify', body: { type: vendorType, reference: p.documentRef, consentRef: p.consentId } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const authentic = bool(r.value['authentic']); const ref = str(r.value['verificationId']);
    if (authentic === undefined || ref === undefined) return ok(malformed());
    const issued = epoch(r.value['issuedAt']); const expires = epoch(r.value['expiresAt']);
    return ok({ kind: 'ANSWERED' as const, value: { authentic, verificationRef: ref, ...(issued === undefined ? {} : { issuedAtEpochSeconds: issued }), ...(expires === undefined ? {} : { expiresAtEpochSeconds: expires }) } });
  }
}
