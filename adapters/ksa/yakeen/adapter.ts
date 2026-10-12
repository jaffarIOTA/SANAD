/**
 * Yakeen — identity verification adapter (CLAUDE.md §5).
 *
 * Implements the IdentityVerificationPort. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 *
 * Assumed contract (no published specification — see README.md): Yakeen is
 * asked for a person by identifier and date of birth, through the operation
 * that fits the identifier (CitizenInfo for a national ID, AlienInfoByIqama
 * for an iqama; operation names from leaked integration code, unconfirmed).
 * It answers the person's attributes (the public SP014 list: Arabic and
 * English first / father / grandfather / family names, gender, date of birth
 * Hijri and Gregorian, nationality, ID expiry) plus a log id; a date of birth
 * that does not match the identifier is an error, not an answer.
 *
 * This adapter maps only the match, the names of the attributes that did not
 * match, and Yakeen's log id. No attribute value crosses this boundary.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import {
  RailAdapter,
  type RailAdapterConfig,
  idStr,
  isoToEpoch,
  malformed,
  obj,
  own,
  str,
} from '../kernel/rail-adapter.ts';
import type { IdentityVerificationPort } from '../../../core/ports/identity-verification.ts';

export const YAKEENADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'YAKEEN-DEV-001',
    summary: 'The service returns the verified attributes themselves (names, gender, date of birth, nationality).',
    containment:
      'Only the match result, the mismatched attribute names and the log id are mapped; attribute values are dropped at this boundary and never stored.',
    verificationRef: 'KSA-RAIL-YAKEEN-01',
  },
  {
    id: 'YAKEEN-DEV-002',
    summary:
      'Operation names (CitizenInfo, AlienInfoByIqama), attribute names and error codes come from unofficial sources.',
    containment:
      'The operation is chosen by the egress from the identifier’s leading digit; an error code this adapter does not know is UNAVAILABLE, never a match.',
    verificationRef: 'KSA-RAIL-YAKEEN-01',
  },
];

/** The attributes the adapter requires in an answer before calling it a match (presence only; values are dropped). */
const REQUIRED_ATTRIBUTES = ['firstName', 'familyName', 'gender', 'dateOfBirthH'] as const;

/** Yakeen errors that mean "the identity does not match", by the attribute that failed (assumed codes). */
const MISMATCH: Readonly<Record<string, readonly string[]>> = {
  DATE_OF_BIRTH_MISMATCH: ['dateOfBirth'],
  ID_EXPIRED: ['idExpiry'],
  ID_NOT_ACTIVE: ['idStatus'],
};

export class YakeenAdapter extends RailAdapter implements IdentityVerificationPort {
  readonly vendorName = 'Yakeen';
  readonly capabilities = ['IDENTITY_VERIFICATION'] as const;
  readonly deviations = YAKEENADAPTER_DEVIATIONS;

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
        path: '/yakeen/v1/person-info',
        // The egress resolves applicantRef to the identifier and declared date of birth, and picks the operation.
        body: { applicantRef: p.applicantRef, consentRef: p.consentId },
      },
      p.correlationId,
    );
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED' as const, code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    const logId = idStr(v['logId']);
    if (logId === undefined) return ok(malformed());
    const verifiedAt = isoToEpoch(v['answeredAt']) ?? BigInt(this.config.nowEpochSeconds());
    const answer = (verified: boolean, mismatches: readonly string[]) =>
      ok({
        kind: 'ANSWERED' as const,
        value: { verified, verificationRef: logId, verifiedAtEpochSeconds: verifiedAt, mismatches },
      });

    const error = obj(v['error']);
    if (error !== undefined) {
      const code = str(error['code']);
      if (code === 'NOT_FOUND') return ok({ kind: 'REFUSED' as const, code: 'NOT_FOUND', referenceId: logId });
      const mismatches = own(MISMATCH, code);
      return mismatches === undefined ? ok(malformed()) : answer(false, mismatches);
    }
    const person = obj(v['personInfo']);
    if (person === undefined || REQUIRED_ATTRIBUTES.some((k) => str(person[k]) === undefined)) return ok(malformed());
    return answer(true, []);
  }
}
