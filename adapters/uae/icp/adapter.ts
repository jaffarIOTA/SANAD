/**
 * ICP — identity verification adapter (ADR 0005).
 *
 * Implements the IdentityVerificationPort against the Federal Authority for
 * Identity, Citizenship, Customs & Port Security: the Emirates ID card is
 * valid, and the applicant's declared attributes match the population
 * register. Consent-gated. Stores the result and the reference, never the
 * attributes.
 *
 * ASSUMED CONTRACT. The authority's validation gateway is contract-gated and
 * publishes no specification. The attribute names this adapter reads are
 * those UAE Pass PUBLISHES for its userinfo claims (docs.uaepass.ae —
 * `idn`, `fullnameEN`, `fullnameAR`, `firstnameEN`, `lastnameEN`,
 * `nationalityEN`, `gender`, `idType`, `userType`), because UAE Pass is the
 * public route to a register-verified Emirates ID. The envelope around them
 * (`verification`, `card`, `subject`) is Sanad's assumption. Both remain
 * verification item UAE-RAIL-ICP-01.
 *
 * The Emirates ID number (`idn`) and every other subject attribute are
 * dropped at this boundary.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { IdentityVerificationPort } from '../../../core/ports/identity-verification.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, malformed, str } from '../../kernel/rail-adapter.ts';
import { isoEpoch } from '../kernel/iso-time.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const ICP_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'ICP-DEV-001',
    summary:
      'The authority returns the card holder’s attributes (Emirates ID number, names, nationality, gender) alongside the match.',
    containment:
      'Only the outcome, the mismatched attribute names (in Sanad’s vocabulary) and the reference are mapped; the subject block is dropped at this boundary and never stored.',
    verificationRef: 'UAE-RAIL-ICP-01',
  },
  {
    id: 'ICP-DEV-002',
    summary: 'A card can match the register and still be expired, cancelled or reported lost.',
    containment:
      'A card status other than VALID makes the verification false with the mismatch "card_status"; an unknown status is malformed, never valid.',
    verificationRef: 'UAE-RAIL-ICP-01',
  },
  {
    id: 'ICP-DEV-003',
    summary:
      'Mismatches are named in UAE Pass attribute vocabulary (fullnameEN, nationalityEN …); the port carries free-text field names.',
    containment:
      'Each attribute is renamed to Sanad’s vocabulary (name, nationality, gender, date_of_birth, id_number, id_type); an attribute we do not know becomes "other", never dropped.',
    verificationRef: 'UAE-RAIL-ICP-01',
  },
];

/** The match outcome: MATCH alone verifies. */
const OUTCOME: Readonly<Record<string, boolean>> = { MATCH: true, PARTIAL_MATCH: false, NO_MATCH: false };
const CARD_VALID: Readonly<Record<string, boolean>> = { VALID: true, EXPIRED: false, CANCELLED: false, LOST: false };
/** UAE Pass attribute names → Sanad's mismatch vocabulary. */
const ATTRIBUTE: Readonly<Record<string, string>> = {
  fullnameEN: 'name',
  fullnameAR: 'name',
  firstnameEN: 'name',
  lastnameEN: 'name',
  firstnameAR: 'name',
  lastnameAR: 'name',
  nationalityEN: 'nationality',
  nationalityAR: 'nationality',
  gender: 'gender',
  dob: 'date_of_birth',
  idn: 'id_number',
  idType: 'id_type',
};

const rec = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Readonly<Record<string, unknown>>) : {};

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
    const consent = await this.requireConsent(p.tenantId, p.consentId, 'IDENTITY_VERIFICATION');
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
    const verification = rec(r.value['verification']);
    const card = rec(r.value['card']);
    const matched = lookupStatus(OUTCOME, verification['outcome']);
    const cardValid = lookupStatus(CARD_VALID, card['status']);
    const ref = str(verification['reference']);
    const at = isoEpoch(verification['verified_at']);
    if (matched === undefined || cardValid === undefined || ref === undefined || at === undefined)
      return ok(malformed());
    const reported = Array.isArray(verification['mismatched_attributes'])
      ? (verification['mismatched_attributes'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const named = [...new Set(reported.map((a) => lookupStatus(ATTRIBUTE, a) ?? 'other'))];
    // A partial or no match that names nothing is still not a match; say so rather than return an empty list.
    const fields = !matched && named.length === 0 ? ['other'] : named;
    const mismatches = cardValid ? fields : [...fields, 'card_status'];
    return ok({
      kind: 'ANSWERED' as const,
      value: { verified: matched && cardValid, verificationRef: ref, verifiedAtEpochSeconds: at, mismatches },
    });
  }
}
