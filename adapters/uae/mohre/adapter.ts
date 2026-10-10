/**
 * MOHRE — employment verification adapter (ADR 0005).
 *
 * Implements the EmploymentVerificationPort from the Ministry of Human
 * Resources and Emiratisation's Wage Protection System salary report:
 * whether the person is employed, by which establishment (as a reference),
 * since when, and the salary paid through WPS. Consent-gated. The salary is
 * an AED snapshot with the provider's reference, never recomputed.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { EmploymentVerificationPort } from '../../../core/ports/employment-verification.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, bool, epoch, malformed, str } from '../../kernel/rail-adapter.ts';
import { aed } from '../kernel/dirham.ts';

export const MOHRE_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'MOHRE-DEV-001',
    summary: 'WPS reports salary actually paid, month by month; the port has one registered salary.',
    containment:
      'The registered salary is the most recent WPS month’s paid amount, in AED minor units, stored with the report reference. The monthly history does not cross the port; a month that cannot be read refuses the whole report rather than being skipped.',
    verificationRef: 'UAE-RAIL-MOHRE-01',
  },
  {
    id: 'MOHRE-DEV-002',
    summary: 'The report names the employer establishment and its labour card details.',
    containment:
      'Only an opaque establishment reference is mapped; the labour card and person number are dropped at this boundary.',
    verificationRef: 'UAE-RAIL-MOHRE-01',
  },
];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class MohreAdapter extends RailAdapter implements EmploymentVerificationPort {
  readonly vendorName = 'MOHRE';
  readonly capabilities = ['EMPLOYMENT_VERIFICATION'] as const;
  readonly deviations = MOHRE_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async employment(p: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly consentId: string;
    readonly correlationId: string;
  }) {
    const consent = await this.requireConsent(p.tenantId, p.consentId, 'EMPLOYMENT_VERIFICATION');
    if (!consent.ok) return consent;
    const r = await this.invoke(
      'employment.wps',
      {
        method: 'POST',
        path: '/v1/wps/salary-reports',
        body: { applicantRef: p.applicantRef, consentRef: p.consentId },
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    const employed = bool(v['employed']);
    const at = epoch(v['asOf']);
    const referenceId = str(v['reportId']);
    if (employed === undefined || at === undefined || referenceId === undefined) return ok(malformed());

    // The most recent month wins; months are "YYYY-MM", which order as strings.
    let latest: { readonly month: string; readonly paid: Money } | undefined;
    if (Array.isArray(v['salaryMonths'])) {
      for (const m of v['salaryMonths'] as unknown[]) {
        const rec = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
        const month = str(rec['month']);
        const paid = aed(rec['paidAmount'], rec['currency']);
        if (month === undefined || !MONTH.test(month) || paid === undefined) return ok(malformed());
        if (latest === undefined || month > latest.month) latest = { month, paid };
      }
    }
    const employer = str(v['establishmentRef']);
    const since = epoch(v['employedSince']);
    return ok({
      kind: 'ANSWERED' as const,
      value: {
        employed,
        retrievedAtEpochSeconds: at,
        referenceId,
        ...(employer === undefined ? {} : { employerRef: employer }),
        ...(latest === undefined ? {} : { registeredSalary: latest.paid }),
        ...(since === undefined ? {} : { employedSinceEpochSeconds: since }),
      },
    });
  }
}
