/**
 * Nafath — identity authentication adapter (CLAUDE.md §5).
 *
 * Implements the IdentityAuthenticationPort port. Vendor vocabulary stops here: the port sees
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
import type { IdentityAuthenticationPort } from '../../../core/ports/identity-authentication.ts';

export const NAFATHADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'NAFATH-DEV-001',
    summary: 'The service identifies the person by national identifier in its own request.',
    containment: 'The port takes an applicant reference; the mapping from reference to identifier happens inside this adapter, is never logged, and the identifier is not returned.',
    verificationRef: 'KSA-RAIL-NAFATH-01',
  },
];

export class NafathAdapter extends RailAdapter implements IdentityAuthenticationPort {
  readonly vendorName = 'Nafath';
  readonly capabilities = ['IDENTITY_AUTHENTICATION'] as const;
  readonly deviations = NAFATHADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async startAuthentication(p: { readonly tenantId: string; readonly applicantRef: string; readonly purpose: 'LOGIN' | 'STEP_UP' | 'SIGNATURE_INTENT'; readonly correlationId: string }) {
    const r = await this.invoke('identity.start', { method: 'POST', path: '/v1/authentications', body: { applicantRef: p.applicantRef, purpose: p.purpose } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const transactionRef = str(r.value['transactionId']); const expires = epoch(r.value['expiresAt']);
    return ok(transactionRef === undefined || expires === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { transactionRef, expiresAtEpochSeconds: expires } });
  }

  async confirmAuthentication(p: { readonly tenantId: string; readonly transactionRef: string; readonly correlationId: string }) {
    const r = await this.invoke('identity.confirm', { method: 'GET', path: `/v1/authentications/${encodeURIComponent(p.transactionRef)}` }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    if (r.value['status'] !== 'COMPLETED') return ok({ kind: 'REFUSED' as const, code: `STATUS_${String(r.value['status'] ?? 'UNKNOWN')}` });
    const assertionId = str(r.value['assertionId']); const identityRef = str(r.value['subjectRef']); const at = epoch(r.value['completedAt']);
    return ok(assertionId === undefined || identityRef === undefined || at === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { assertionId, identityRef, authenticatedAtEpochSeconds: at } });
  }
}
