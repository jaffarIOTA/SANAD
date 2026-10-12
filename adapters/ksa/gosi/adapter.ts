/**
 * GOSI — employment verification adapter (CLAUDE.md §5).
 *
 * Implements the EmploymentVerificationPort. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 *
 * Assumed contract (no published API — see README.md): the contents of the
 * public GOSI wage (salary) certificate — the certificate number, and per
 * employment the employer establishment (number and name), the join date, the
 * registered wage (basic wage, housing allowance, other allowances, total) and
 * the employment status. The likely live route is Wathq's "Employee
 * Information (MASDR/GOSI)" service rather than a direct GOSI connection.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import { type Money, money } from '../../../core/kernel/money.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import {
  RailAdapter,
  type RailAdapterConfig,
  arr,
  idStr,
  isoToEpoch,
  malformed,
  obj,
  own,
} from '../kernel/rail-adapter.ts';
import { KSA_CURRENCY, sar } from '../kernel/riyal.ts';
import type { EmploymentVerificationPort } from '../../../core/ports/employment-verification.ts';

export const GOSIADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'GOSI-DEV-001',
    summary: 'The registered wage is returned as decimals (basic, housing, other, total).',
    containment:
      'Converted to minor units by digit manipulation and stored as a snapshot with the certificate number; never recomputed. Where the total is absent, basic plus housing plus other is the registered wage.',
    verificationRef: 'KSA-RAIL-GOSI-01',
  },
  {
    id: 'GOSI-DEV-002',
    summary: 'The certificate names the contributor (name, identifier, nationality).',
    containment: 'Contributor attributes are dropped at this boundary; only employment facts and references cross.',
    verificationRef: 'KSA-RAIL-GOSI-01',
  },
];

/** Employment status on the certificate to "currently employed there" (assumed vocabulary). */
const ACTIVE: Readonly<Record<string, boolean>> = {
  ACTIVE: true,
  INACTIVE: false,
  TERMINATED: false,
};

interface Employment {
  readonly active: boolean;
  readonly establishment: string;
  readonly joined: bigint | undefined;
  readonly wage: Money;
}

function employmentOf(raw: unknown): Employment | undefined {
  const e = obj(raw);
  const active = own(ACTIVE, e?.['employmentStatus']);
  const establishment = idStr(e?.['establishmentNumber']);
  const wageBlock = obj(e?.['wage']);
  if (e === undefined || active === undefined || establishment === undefined || wageBlock === undefined)
    return undefined;
  const currency = wageBlock['currency'];
  const total = sar(wageBlock['totalWage'], currency);
  const parts = ['basicWage', 'housingAllowance', 'otherAllowances'].map((k) =>
    wageBlock[k] === undefined ? sar('0') : sar(wageBlock[k], currency),
  );
  if (parts.some((x) => x === undefined)) return undefined;
  const summed = parts.reduce((s, x) => s + (x?.minorUnits ?? 0n), 0n);
  if (wageBlock['totalWage'] !== undefined && total === undefined) return undefined;
  const wage = total ?? money(summed, KSA_CURRENCY);
  if (wage.minorUnits < 0n) return undefined;
  return { active, establishment, joined: isoToEpoch(e['joiningDate']), wage };
}

export class GosiAdapter extends RailAdapter implements EmploymentVerificationPort {
  readonly vendorName = 'GOSI';
  readonly capabilities = ['EMPLOYMENT_VERIFICATION'] as const;
  readonly deviations = GOSIADAPTER_DEVIATIONS;

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
      'employment.status',
      {
        method: 'POST',
        path: '/gosi/v1/wage-certificates',
        // The egress resolves applicantRef to the contributor's identifier.
        body: { applicantRef: p.applicantRef, consentRef: p.consentId },
      },
      p.correlationId,
    );
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED' as const, code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const referenceId = idStr(r.value['certificateNumber']);
    const list = arr(r.value['employments']);
    if (referenceId === undefined || list === undefined) return ok(malformed());
    const employments: Employment[] = [];
    for (const raw of list) {
      const e = employmentOf(raw);
      // One employment that does not read is not silently left out of an affordability snapshot.
      if (e === undefined) return ok(malformed());
      employments.push(e);
    }
    const retrievedAtEpochSeconds = BigInt(this.config.nowEpochSeconds());
    // The primary employment is the active one with the highest registered wage.
    const primary = employments
      .filter((e) => e.active)
      .reduce<Employment | undefined>(
        (best, e) => (best === undefined || e.wage.minorUnits > best.wage.minorUnits ? e : best),
        undefined,
      );
    if (primary === undefined)
      return ok({ kind: 'ANSWERED' as const, value: { employed: false, retrievedAtEpochSeconds, referenceId } });
    return ok({
      kind: 'ANSWERED' as const,
      value: {
        employed: true,
        retrievedAtEpochSeconds,
        referenceId,
        employerRef: `gosi-establishment:${primary.establishment}`,
        registeredSalary: primary.wage,
        ...(primary.joined === undefined ? {} : { employedSinceEpochSeconds: primary.joined }),
      },
    });
  }
}
