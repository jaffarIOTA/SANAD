/**
 * ICP — identity verification adapter (ADR 0005).
 *
 * Implements the IdentityVerificationPort against the Federal Authority for
 * Identity, Citizenship, Customs & Port Security: the Emirates ID card is
 * valid, and the applicant's declared attributes match the population
 * register. Consent-gated. Stores the result and the reference, never the
 * attributes.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { IdentityVerificationPort } from '../../../core/ports/identity-verification.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, bool, epoch, malformed, str } from '../../kernel/rail-adapter.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const ICP_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'ICP-DEV-001',
    summary:
      'The authority returns the card holder’s attributes (name, nationality, date of birth, card expiry) alongside the match.',
    containment:
      'Only the match result, the mismatched field names and the reference are mapped; attribute values are dropped at this boundary and never stored.',
    verificationRef: 'UAE-RAIL-ICP-01',
  },
  {
    id: 'ICP-DEV-002',
    summary: 'A card can match the register and still be expired, cancelled or reported lost.',
    containment:
      'A card status other than VALID makes the verification false with the mismatch "card_status"; an unknown status is malformed, never valid.',
    verificationRef: 'UAE-RAIL-ICP-01',
  },
];

const CARD_VALID: Readonly<Record<string, boolean>> = { VALID: true, EXPIRED: false, CANCELLED: false, LOST: false };

export class IcpAdapter extends RailAdapter implements IdentityVerificationPort {
  readonly vendorName = 'ICP';
  readonly capabilities = ['IDENTITY_VERIFICATION'] as const;
  readonly deviations = ICP_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async verify(p: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly consentId: string;
    readonly correlationId: string;
  }) {
    const consent = this.requireConsent(p.consentId);
    if (!consent.ok) return consent;
    const r = await this.invoke(
      'identity.verify',
      {
        method: 'POST',
        path: '/v1/identity-verifications',
        body: { applicantRef: p.applicantRef, consentRef: p.consentId },
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    const matched = bool(v['matched']);
    const cardValid = lookupStatus(CARD_VALID, v['cardStatus']);
    const ref = str(v['verificationId']);
    const at = epoch(v['verifiedAt']);
    if (matched === undefined || cardValid === undefined || ref === undefined || at === undefined)
      return ok(malformed());
    const fields = Array.isArray(v['mismatchedFields'])
      ? (v['mismatchedFields'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const mismatches = cardValid ? fields : [...fields, 'card_status'];
    return ok({
      kind: 'ANSWERED' as const,
      value: { verified: matched && cardValid, verificationRef: ref, verifiedAtEpochSeconds: at, mismatches },
    });
  }
}
