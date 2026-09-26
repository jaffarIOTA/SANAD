/**
 * GOSI — employment verification adapter (CLAUDE.md §5).
 *
 * Implements the EmploymentVerificationPort port. Vendor vocabulary stops here: the port sees
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
import type { EmploymentVerificationPort } from '../../../core/ports/employment-verification.ts';

export const GOSIADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'GOSI-DEV-001',
    summary: 'The registered salary is returned as a decimal.',
    containment: 'Converted to minor units by digit manipulation and stored as a snapshot with the provider reference; never recomputed.',
    verificationRef: 'KSA-RAIL-GOSI-01',
  },
];

export class GosiAdapter extends RailAdapter implements EmploymentVerificationPort {
  readonly vendorName = 'GOSI';
  readonly capabilities = ['EMPLOYMENT_VERIFICATION'] as const;
  readonly deviations = GOSIADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async employment(p: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly correlationId: string }) {
    const consent = this.requireConsent(p.consentId); if (!consent.ok) return consent;
    const r = await this.invoke('employment.status', { method: 'POST', path: '/v1/employment', body: { applicantRef: p.applicantRef, consentRef: p.consentId } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const employed = bool(r.value['employed']); const at = epoch(r.value['asOf']); const referenceId = str(r.value['referenceId']);
    if (employed === undefined || at === undefined || referenceId === undefined) return ok(malformed());
    const salary = decimalToMinor(r.value['registeredSalary']); const employer = str(r.value['employerRef']); const since = epoch(r.value['employedSince']);
    return ok({ kind: 'ANSWERED' as const, value: { employed, retrievedAtEpochSeconds: at, referenceId, ...(employer === undefined ? {} : { employerRef: employer }), ...(salary === undefined ? {} : { registeredSalary: money(salary) }), ...(since === undefined ? {} : { employedSinceEpochSeconds: since }) } });
  }
}
