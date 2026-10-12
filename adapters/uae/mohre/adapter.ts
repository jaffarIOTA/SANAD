/**
 * MOHRE — employment verification adapter (ADR 0005).
 *
 * Implements the EmploymentVerificationPort from the Ministry of Human
 * Resources and Emiratisation's Wage Protection System: whether the person is
 * employed, by which establishment (as a reference), since when, and the
 * salary paid through WPS. Consent-gated. The salary is an AED snapshot with
 * the provider's reference, never recomputed.
 *
 * ASSUMED CONTRACT. MOHRE offers lenders no published API. The records this
 * adapter reads are modelled on the published WPS Salary Information File
 * (SIF) that every employer's agent submits each month — the SCR (salary
 * control record: employer id, salary month MMYYYY, EDR count, total salary,
 * currency) and the EDR (employee detail record: pay period, days, fixed
 * income, variable income, days on leave) — wrapped in a JSON report.
 * The SIF record fields are public (bank and exchange-house SIF guides); the
 * JSON names and the report envelope are Sanad's assumption and remain
 * verification item UAE-RAIL-MOHRE-01.
 *
 * Beyond the port, `establishmentCompliance()` summarises an employer's SIF
 * control records against the WPS compliance rule that an establishment has
 * paid at least 85% of its employees due in a month (Ministerial Resolution
 * 340/2026, as recorded in docs/rails/public-structures.md — confirm the
 * article before a credit policy relies on it).
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { EmploymentVerificationPort } from '../../../core/ports/employment-verification.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { type Result, ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, int, malformed, str } from '../../kernel/rail-adapter.ts';
import { aed } from '../kernel/dirham.ts';
import { isoEpoch } from '../kernel/iso-time.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const MOHRE_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'MOHRE-DEV-001',
    summary:
      'WPS reports salary actually paid, month by month, as fixed and variable income; the port has one registered salary.',
    containment:
      'The registered salary is the most recent SIF month’s FIXED income (the EDR’s fixed component), in AED minor units, stored with the report reference; variable income (overtime, bonus) is left out because it does not recur. The monthly history does not cross the port; a month that cannot be read refuses the whole report rather than being skipped.',
    verificationRef: 'UAE-RAIL-MOHRE-01',
  },
  {
    id: 'MOHRE-DEV-002',
    summary:
      'The SIF carries the employee’s person id (labour card), routing code and IBAN, and the employer’s MOHRE establishment id.',
    containment:
      'Only an opaque establishment reference is mapped; the person id, labour card, routing code, IBAN and employer id are dropped at this boundary.',
    verificationRef: 'UAE-RAIL-MOHRE-01',
  },
  {
    id: 'MOHRE-DEV-003',
    summary:
      'The WPS compliance of an establishment (paid at least 85% of its employees due in the month) has no field on the employment port.',
    containment:
      'establishmentCompliance() is an adapter method, keyed by trade licence and consent-gated, computed in integer arithmetic (paid × 100 ≥ due × 85). Putting it on a port is a port change, not an adapter workaround.',
    verificationRef: 'UAE-RAIL-MOHRE-01',
  },
];

/** Employment status as the report states it: still employed or not. */
const EMPLOYED: Readonly<Record<string, boolean>> = {
  ACTIVE: true,
  ON_LEAVE: true,
  TERMINATED: false,
  CANCELLED: false,
  ABSCONDED: false,
};

/** The SIF salary month, MMYYYY. */
const SIF_MONTH = /^(0[1-9]|1[0-2])(\d{4})$/;
/** MMYYYY → YYYY-MM, which orders as a string. */
const isoMonth = (v: unknown): string | undefined => {
  const m = typeof v === 'string' ? SIF_MONTH.exec(v) : null;
  return m === null ? undefined : `${m[2] ?? ''}-${m[1] ?? ''}`;
};

/** The WPS rule: at least 85% of the employees due were paid in the month. Integer arithmetic. */
export const WPS_COMPLIANT_PAID_PERCENT = 85;
export const wpsCompliant = (paid: number, due: number): boolean =>
  due === 0 || paid * 100 >= due * WPS_COMPLIANT_PAID_PERCENT;

type Rec = Readonly<Record<string, unknown>>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const count = (v: unknown): number | undefined => {
  const n = int(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

export interface WpsMonth {
  readonly payMonth: string;
  readonly employeesDue: number;
  readonly employeesPaid: number;
  readonly totalPaid: Money;
  readonly compliant: boolean;
}

export interface EstablishmentCompliance {
  readonly establishmentRef: string;
  /** Oldest first. */
  readonly months: readonly WpsMonth[];
  /** The most recent month's compliance; false where no month was reported. */
  readonly compliantLatestMonth: boolean;
  readonly referenceId: string;
  readonly retrievedAtEpochSeconds: bigint;
}

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
    const report = rec(r.value['report']);
    const employee = rec(r.value['employee']);
    const employed = lookupStatus(EMPLOYED, employee['employment_status']);
    const at = isoEpoch(report['generated_at']);
    const referenceId = str(report['reference']);
    if (employed === undefined || at === undefined || referenceId === undefined) return ok(malformed());

    // The most recent month wins; months become "YYYY-MM", which order as strings.
    let latest: { readonly month: string; readonly fixed: Money } | undefined;
    const records = r.value['salary_records'];
    if (records !== undefined && !Array.isArray(records)) return ok(malformed());
    for (const raw of (records ?? []) as unknown[]) {
      const scr = rec(rec(raw)['scr']);
      const edr = rec(rec(raw)['edr']);
      const month = isoMonth(scr['salary_month']);
      const fixed = aed(edr['fixed_income'], scr['currency']);
      const variable = aed(edr['variable_income'] ?? '0', scr['currency']);
      if (month === undefined || fixed === undefined || variable === undefined) return ok(malformed());
      if (latest === undefined || month > latest.month) latest = { month, fixed };
    }
    const employer = str(employee['establishment_ref']);
    const since = employee['contract_start_date'] === undefined ? undefined : isoEpoch(employee['contract_start_date']);
    return ok({
      kind: 'ANSWERED' as const,
      value: {
        employed,
        retrievedAtEpochSeconds: at,
        referenceId,
        ...(employer === undefined ? {} : { employerRef: employer }),
        ...(latest === undefined ? {} : { registeredSalary: latest.fixed }),
        ...(since === undefined ? {} : { employedSinceEpochSeconds: since }),
      },
    });
  }

  /** An establishment's WPS record by trade licence (MOHRE-DEV-003). Consent-gated like the employee report. */
  async establishmentCompliance(p: {
    readonly tenantId: string;
    readonly tradeLicence: string;
    readonly consentId: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<EstablishmentCompliance>>> {
    const consent = await this.requireConsent(p.tenantId, p.consentId, 'EMPLOYMENT_VERIFICATION');
    if (!consent.ok) return consent;
    const r = await this.invoke(
      'employment.wps.establishment',
      {
        method: 'POST',
        path: '/v1/wps/establishment-reports',
        body: { tradeLicenceNumber: p.tradeLicence, consentRef: p.consentId },
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const report = rec(r.value['report']);
    const establishment = rec(r.value['establishment']);
    const at = isoEpoch(report['generated_at']);
    const referenceId = str(report['reference']);
    const establishmentRef = str(establishment['establishment_ref']);
    const scrs = r.value['salary_control_records'];
    if (at === undefined || referenceId === undefined || establishmentRef === undefined || !Array.isArray(scrs))
      return ok(malformed());
    const months: WpsMonth[] = [];
    for (const raw of scrs as unknown[]) {
      const scr = rec(raw);
      const payMonth = isoMonth(scr['salary_month']);
      const paid = count(scr['edr_count']);
      const due = count(scr['employees_due']);
      const total = aed(scr['total_salary'], scr['currency']);
      if (payMonth === undefined || paid === undefined || due === undefined || total === undefined)
        return ok(malformed());
      months.push({
        payMonth,
        employeesDue: due,
        employeesPaid: paid,
        totalPaid: total,
        compliant: wpsCompliant(paid, due),
      });
    }
    months.sort((a, b) => a.payMonth.localeCompare(b.payMonth));
    return ok({
      kind: 'ANSWERED',
      value: {
        establishmentRef,
        months,
        compliantLatestMonth: months.at(-1)?.compliant ?? false,
        referenceId,
        retrievedAtEpochSeconds: at,
      },
    });
  }
}
