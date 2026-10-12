/**
 * AECB — Al Etihad Credit Bureau, credit bureau adapter (ADR 0005).
 *
 * Implements the CreditBureauPort. Commercial reports are keyed by trade
 * licence, individual reports by an applicant reference the adapter resolves
 * to the Emirates ID inside its own boundary. Consent-gated: no consent id,
 * no call. Amounts are AED and become minor units without a float.
 *
 * ASSUMED CONTRACT. The bureau publishes no schema (member access only). The
 * report this adapter reads follows the layout common to international
 * credit-bureau reports — a report block, a subject block, a score block
 * (score, band, reason codes), credit contracts (type, role, status, limit,
 * outstanding, overdue, days past due, monthly payment history), enquiries,
 * and public records (court cases, bounced cheques) — with what AECB states
 * publicly: a score from 300 to 900 where higher means lower risk, for
 * individuals and companies, and reports that carry payment history,
 * contracts, court obligations and bounced cheques (u.ae, "financial
 * credibility"). Field names are an analogue and remain verification item
 * UAE-RAIL-AECB-01.
 *
 * The report is reduced here to the port's BureauSummary; nothing else
 * crosses.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type {
  BureauOutcome,
  BureauRequest,
  BureauSummary,
  CreditBureauPort,
  FacilityReport,
} from '../../../core/ports/credit-bureau.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { type Result, ok } from '../../../core/kernel/result.ts';
import type { TsaInstant } from '../../../core/time/tsa.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { type Body, RailAdapter, type RailAdapterConfig, int, str } from '../../kernel/rail-adapter.ts';
import { UAE_CURRENCY, aed, requireAed } from '../kernel/dirham.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const AECB_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'AECB-DEV-001',
    summary:
      'The bureau keys a commercial report on the trade licence number (and issuing authority); the port field is named commercialRegistration.',
    containment:
      'The trade licence number travels in BureauRequest.commercialRegistration and is renamed only inside this adapter. The port is not renamed; the naming debt is recorded against ADR 0005.',
    verificationRef: 'UAE-RAIL-AECB-01',
  },
  {
    id: 'AECB-DEV-002',
    summary: 'The port has no subject type; the bureau sells commercial and individual reports.',
    containment:
      'request() is the commercial report the SME journey needs; requestIndividual() is an adapter method for owner and guarantor reports, keyed by applicant reference. The Emirates ID never crosses the port.',
    verificationRef: 'UAE-RAIL-AECB-01',
  },
  {
    id: 'AECB-DEV-003',
    summary: 'Amounts arrive as AED decimals and the score as the bureau’s own integer on a published 300–900 scale.',
    containment:
      'Decimals become AED minor units by digit manipulation; an answer in another currency is malformed. A score outside 300–900, or a report stating another scale, is malformed. The score is an opaque figure, compared but never used arithmetically.',
    verificationRef: 'UAE-RAIL-AECB-01',
  },
  {
    id: 'AECB-DEV-004',
    summary:
      'The report carries far more than the port: score band and reason codes, per-contract limits and payment history, enquiries, court cases.',
    containment:
      'Reduced here: exposure, overdue and active count over open contracts where the subject is the borrower (a guarantee is contingent and is not exposure); worst days past due over current and historical months; defaults are defaulted or written-off contracts and bounced cheques. Band, reason codes, enquiries and court cases do not cross the port — a port extension, not an adapter workaround, if credit policy needs them.',
    verificationRef: 'UAE-RAIL-AECB-01',
  },
];

const UNAVAILABLE = (reason: string): BureauOutcome => ({ kind: 'UNAVAILABLE', reason });
const MALFORMED = UNAVAILABLE('response malformed');

/** The published scale (higher is lower risk). */
export const AECB_SCORE_MIN = 300;
export const AECB_SCORE_MAX = 900;

type ContractState = 'OPEN' | 'DEFAULT' | 'CLOSED';
const CONTRACT_STATUS: Readonly<Record<string, ContractState>> = {
  ACTIVE: 'OPEN',
  RESTRUCTURED: 'OPEN',
  DEFAULTED: 'DEFAULT',
  WRITTEN_OFF: 'DEFAULT',
  CLOSED: 'CLOSED',
  SETTLED: 'CLOSED',
};
const ROLE_IS_BORROWER: Readonly<Record<string, boolean>> = { PRIMARY: true, JOINT: true, GUARANTOR: false };

type Rec = Readonly<Record<string, unknown>>;
const rec = (v: unknown): Rec | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;
/** `{ amount, currency }` in AED; an absent object is zero only where the caller says so. */
const amountOf = (v: unknown): Money | undefined => {
  const o = rec(v);
  return o === undefined ? undefined : aed(o['amount'], o['currency']);
};
const dpdOf = (v: unknown): number | undefined => {
  const n = int(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

interface Reduced {
  readonly totalExposure: bigint;
  readonly overdue: bigint;
  readonly worst: number;
  readonly active: number;
  readonly defaults: BureauSummary['defaults'][number][];
}

/** The contracts and public records, reduced. `undefined` (malformed) if any entry cannot be read: one unreadable line refuses the whole report. */
function reduce(contracts: unknown, publicRecords: unknown): Reduced | undefined {
  if (!Array.isArray(contracts)) return undefined;
  let totalExposure = 0n;
  let overdue = 0n;
  let worst = 0;
  let active = 0;
  const defaults: BureauSummary['defaults'][number][] = [];
  for (const raw of contracts as unknown[]) {
    const c = rec(raw);
    if (c === undefined) return undefined;
    const state = lookupStatus(CONTRACT_STATUS, c['status']);
    const borrower = lookupStatus(ROLE_IS_BORROWER, c['role']);
    const outstanding = amountOf(c['outstanding_balance']);
    const late = c['overdue_amount'] === undefined ? undefined : amountOf(c['overdue_amount']);
    const dpd = dpdOf(c['days_past_due'] ?? 0);
    if (
      state === undefined ||
      borrower === undefined ||
      outstanding === undefined ||
      (c['overdue_amount'] !== undefined && late === undefined) ||
      dpd === undefined
    )
      return undefined;
    if (c['credit_limit'] !== undefined && amountOf(c['credit_limit']) === undefined) return undefined;
    let contractWorst = dpd;
    const history = c['payment_history'];
    if (history !== undefined) {
      if (!Array.isArray(history)) return undefined;
      for (const m of history as unknown[]) {
        const month = rec(m);
        const d = dpdOf(month?.['days_past_due']);
        if (d === undefined || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month?.['period']))) return undefined;
        contractWorst = Math.max(contractWorst, d);
      }
    }
    if (!borrower) continue;
    worst = Math.max(worst, contractWorst);
    if (state === 'CLOSED') continue;
    totalExposure += outstanding.minorUnits;
    overdue += late?.minorUnits ?? 0n;
    active += 1;
    if (state === 'DEFAULT') defaults.push({ amount: outstanding, settled: false });
  }
  const records = rec(publicRecords);
  const cheques = records?.['bounced_cheques'];
  if (cheques !== undefined) {
    if (!Array.isArray(cheques)) return undefined;
    for (const raw of cheques as unknown[]) {
      const b = rec(raw);
      const amount = amountOf(b?.['amount']);
      if (b === undefined || amount === undefined || typeof b['settled'] !== 'boolean') return undefined;
      defaults.push({ amount, settled: b['settled'] });
    }
  }
  return { totalExposure, overdue, worst, active, defaults };
}

export class AecbAdapter extends RailAdapter implements CreditBureauPort {
  readonly vendorName = 'AECB';
  readonly capabilities = ['CREDIT_BUREAU'] as const;
  readonly deviations = AECB_DEVIATIONS;

  readonly #attest: () => Promise<TsaInstant>;

  constructor(
    config: RailAdapterConfig,
    credentials: CredentialProvider,
    transport: RailTransport,
    attest: () => Promise<TsaInstant>,
  ) {
    super(config, credentials, transport);
    this.#attest = attest;
  }

  /** The commercial report. `commercialRegistration` carries the trade licence number (AECB-DEV-001). */
  async request(req: BureauRequest): Promise<Result<BureauOutcome>> {
    const consent = await this.requireConsent(req.tenantId, req.consentId, 'CREDIT_BUREAU');
    if (!consent.ok) return consent;
    return this.#enquire(
      'bureau.commercial',
      '/v1/reports/commercial',
      { tradeLicenceNumber: req.commercialRegistration, consentRef: req.consentId, purpose: 'NEW_CREDIT_APPLICATION' },
      req.correlationId,
    );
  }

  /** An owner's or guarantor's individual report (AECB-DEV-002). The adapter resolves the reference; no identifier is passed in. */
  async requestIndividual(req: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly consentId: string;
    readonly correlationId: string;
  }): Promise<Result<BureauOutcome>> {
    const consent = await this.requireConsent(req.tenantId, req.consentId, 'CREDIT_BUREAU');
    if (!consent.ok) return consent;
    return this.#enquire(
      'bureau.individual',
      '/v1/reports/individual',
      { applicantRef: req.applicantRef, consentRef: req.consentId, purpose: 'NEW_CREDIT_APPLICATION' },
      req.correlationId,
    );
  }

  async report(rep: FacilityReport): ReturnType<CreditBureauPort['report']> {
    const currency = requireAed(rep.amount);
    if (!currency.ok) return currency;
    const r = await this.invoke(
      'bureau.report',
      {
        method: 'POST',
        path: '/v1/facilities/events',
        body: {
          facilityRef: rep.facilityRef,
          event: rep.event,
          amount: rep.amount.minorUnits.toString(),
          currency: rep.amount.currency,
          asOf: rep.asOfEpochSeconds.toString(),
          idempotencyKey: rep.idempotencyKey,
        },
      },
      rep.correlationId,
    );
    if (r.kind !== 'ANSWERED')
      return ok({ kind: 'UNAVAILABLE' as const, reason: r.kind === 'REFUSED' ? `refused: ${r.code}` : r.reason });
    const ack = str(r.value['submissionId']);
    return ok(
      ack === undefined
        ? { kind: 'UNAVAILABLE' as const, reason: 'response malformed' }
        : { kind: 'ACKNOWLEDGED' as const, acknowledgementRef: ack },
    );
  }

  async #enquire(operation: string, path: string, body: Body, correlationId: string): Promise<Result<BureauOutcome>> {
    const r = await this.invoke(operation, { method: 'POST', path, body }, correlationId);
    if (r.kind === 'UNAVAILABLE')
      return ok({
        kind: 'UNAVAILABLE',
        reason: r.reason,
        ...(r.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: r.retryAfterSeconds }),
      });
    // A refusal is not a clean file: it routes to the bureau-unavailable exception, never to a decline or a pass.
    if (r.kind === 'REFUSED') return ok(UNAVAILABLE(`refused: ${r.code}`));
    const report = rec(r.value['report']);
    const reference = str(report?.['reference']);
    if (report === undefined || reference === undefined) return ok(MALFORMED);
    if (report['subject_found'] === false) return ok({ kind: 'NO_RECORD', bureauReference: reference });
    if (report['subject_found'] !== true) return ok(MALFORMED);

    const reduced = reduce(r.value['contracts'], r.value['public_records']);
    if (reduced === undefined) return ok(MALFORMED);

    let bureauScore: number | undefined;
    const score = rec(r.value['score']);
    if (score !== undefined) {
      bureauScore = int(score['value']);
      const min = score['range_min'] ?? AECB_SCORE_MIN;
      const max = score['range_max'] ?? AECB_SCORE_MAX;
      if (
        bureauScore === undefined ||
        min !== AECB_SCORE_MIN ||
        max !== AECB_SCORE_MAX ||
        bureauScore < AECB_SCORE_MIN ||
        bureauScore > AECB_SCORE_MAX
      )
        return ok(MALFORMED);
    }
    return ok({
      kind: 'REPORT',
      summary: {
        bureauReference: reference,
        retrievedAt: await this.#attest(),
        totalExposure: { minorUnits: reduced.totalExposure, currency: UAE_CURRENCY },
        overdueAmount: { minorUnits: reduced.overdue, currency: UAE_CURRENCY },
        worstDelinquencyDays: reduced.worst,
        activeFacilities: reduced.active,
        ...(bureauScore === undefined ? {} : { bureauScore }),
        defaults: reduced.defaults,
      },
    });
  }
}
