/**
 * Yakeen — identity verification adapter (CLAUDE.md §5).
 *
 * Implements the IdentityVerificationPort port. Vendor vocabulary stops here: the port sees
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
import type { IdentityVerificationPort } from '../../../core/ports/identity-verification.ts';

export const YAKEENADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'YAKEEN-DEV-001',
    summary: 'The service returns the verified attributes themselves (name, date of birth, address).',
    containment: 'Only the match result, the mismatch field names and the reference are mapped; attribute values are dropped at this boundary and never stored.',
    verificationRef: 'KSA-RAIL-YAKEEN-01',
  },
];

export class YakeenAdapter extends RailAdapter implements IdentityVerificationPort {
  readonly vendorName = 'Yakeen';
  readonly capabilities = ['IDENTITY_VERIFICATION'] as const;
  readonly deviations = YAKEENADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async verify(p: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly correlationId: string }) {
    const consent = this.requireConsent(p.consentId); if (!consent.ok) return consent;
    const r = await this.invoke('identity.verify', { method: 'POST', path: '/v1/verifications', body: { applicantRef: p.applicantRef, consentRef: p.consentId } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const verified = bool(r.value['matched']); const ref = str(r.value['verificationId']); const at = epoch(r.value['verifiedAt']);
    const mismatches = Array.isArray(r.value['mismatchedFields']) ? (r.value['mismatchedFields'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    return ok(verified === undefined || ref === undefined || at === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { verified, verificationRef: ref, verifiedAtEpochSeconds: at, mismatches } });
  }
}
