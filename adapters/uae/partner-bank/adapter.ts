/**
 * Partner bank — payments adapter (ADR 0005).
 *
 * Implements the PaymentsPort through the bank the institution contracts for
 * money movement: a development fund that holds no settlement account of its
 * own disburses to the borrower, and collects instalments, through its
 * partner bank. The bank chooses the domestic rail (instant payment, the
 * federal transfer system, internal book transfer); the port never names one.
 *
 * Every instruction is in AED and carries the outbox event's idempotency key,
 * so a retried event cannot pay twice.
 *
 * ASSUMED CONTRACT. Each bank exposes its own corporate API. The shape this
 * adapter speaks is modelled on ISO 20022, which UAE banks and the central
 * bank's payment systems use: the instruction carries pain.001-style elements
 * (PmtId/InstrId, EndToEndId, InstdAmt with Ccy, Purp/Cd), and the answer is a
 * pain.002 / pacs.002 transaction status (TxInfAndSts: OrgnlInstrId, TxSts
 * from the ExternalPaymentTransactionStatus1Code list, StsRsnInf/Rsn/Cd,
 * AccptncDtTm, AcctSvcrRef), with pacs.004-style return information (RtrInf)
 * for a returned collection. JSON element names and the endpoints are an
 * analogue of the XML message, and remain verification item
 * UAE-RAIL-PARTNER-BANK-01.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { PaymentsPort } from '../../../core/ports/payments.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { type Body, RailAdapter, type RailAdapterConfig, malformed, str } from '../../kernel/rail-adapter.ts';
import { aedDecimal, requireAed } from '../kernel/dirham.ts';
import { isoEpoch } from '../kernel/iso-time.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const PARTNER_BANK_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'PARTNER-BANK-DEV-001',
    summary:
      'Each partner bank exposes its own corporate payments API; there is no national payments hub contract to code against.',
    containment:
      'The adapter speaks one ISO 20022-shaped instruction (InstrId = idempotency key, EndToEndId = our reference, InstdAmt in AED as a decimal string, Purp/Cd). A bank whose API differs gets its own route table here, never a branch in the engine.',
    verificationRef: 'UAE-RAIL-PARTNER-BANK-01',
  },
  {
    id: 'PARTNER-BANK-DEV-002',
    summary: 'Domestic transfers require a payment purpose code from the central bank’s list.',
    containment:
      'The purpose code is passed through as the engine supplied it; which codes the bank accepts for a loan disbursement and an instalment collection is the verification item.',
    verificationRef: 'UAE-RAIL-PARTNER-BANK-01',
  },
  {
    id: 'PARTNER-BANK-DEV-003',
    summary:
      'ISO 20022 statuses are finer than the port’s (RCVD, PDNG, ACTC, ACCP, ACSP, ACWC, ACSC, RJCT), and a rejection carries a reason code.',
    containment:
      'ACSC → SETTLED; RJCT → REJECTED; every other accepted-or-pending code → ACCEPTED (not settled). Return information on a collection → RETURNED. The rejection reason (e.g. AC04, AM04) does not cross the port. A status report for another instruction (OrgnlInstrId ≠ our key) or an unknown code is malformed.',
    verificationRef: 'UAE-RAIL-PARTNER-BANK-01',
  },
];

type Settlement = 'ACCEPTED' | 'SETTLED' | 'REJECTED';
/** ExternalPaymentTransactionStatus1Code → the port's status. */
const TX_STATUS: Readonly<Record<string, Settlement>> = {
  RCVD: 'ACCEPTED',
  PDNG: 'ACCEPTED',
  ACTC: 'ACCEPTED',
  ACCP: 'ACCEPTED',
  ACSP: 'ACCEPTED',
  ACWC: 'ACCEPTED',
  ACSC: 'SETTLED',
  RJCT: 'REJECTED',
};

type Rec = Readonly<Record<string, unknown>>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});

export class PartnerBankAdapter extends RailAdapter implements PaymentsPort {
  readonly vendorName = 'Partner bank';
  readonly capabilities = ['PAYMENTS'] as const;
  readonly deviations = PARTNER_BANK_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async disburse(p: {
    readonly tenantId: string;
    readonly beneficiaryRef: string;
    readonly amount: Money;
    readonly purposeCode: string;
    readonly reference: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }) {
    const currency = this.#instructable(p.amount);
    if (!currency.ok) return currency;
    const r = await this.#instruct(
      'payments.disburse',
      '/v1/payments/credit-transfers',
      {
        PmtId: { InstrId: p.idempotencyKey, EndToEndId: p.reference },
        InstdAmt: { Ccy: p.amount.currency, Amt: aedDecimal(p.amount) },
        Cdtr: { Ref: p.beneficiaryRef },
        Purp: { Cd: p.purposeCode },
      },
      p.idempotencyKey,
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    // A credit transfer has no return in the port's vocabulary; return information here is malformed.
    if (r.value.returned) return ok(malformed());
    const { instructionRef, status, acceptedAtEpochSeconds } = r.value;
    return ok({ kind: 'ANSWERED' as const, value: { instructionRef, status, acceptedAtEpochSeconds } });
  }

  async collect(p: {
    readonly tenantId: string;
    readonly payerRef: string;
    readonly amount: Money;
    readonly reference: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }) {
    const currency = this.#instructable(p.amount);
    if (!currency.ok) return currency;
    const r = await this.#instruct(
      'payments.collect',
      '/v1/payments/direct-debits',
      {
        PmtId: { InstrId: p.idempotencyKey, EndToEndId: p.reference },
        InstdAmt: { Ccy: p.amount.currency, Amt: aedDecimal(p.amount) },
        Dbtr: { Ref: p.payerRef },
      },
      p.idempotencyKey,
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const { instructionRef, status, acceptedAtEpochSeconds, returned } = r.value;
    return ok({
      kind: 'ANSWERED' as const,
      value: { instructionRef, status: returned ? ('RETURNED' as const) : status, acceptedAtEpochSeconds },
    });
  }

  /** AED, and strictly positive: a zero or negative instruction is a fault upstream, not a payment. */
  #instructable(amount: Money): Result<true> {
    const currency = requireAed(amount);
    if (!currency.ok) return currency;
    return amount.minorUnits > 0n
      ? currency
      : reject('OP-DETERMINACY', 'AMOUNT_NOT_POSITIVE', 'A payment instruction is for a positive amount');
  }

  async #instruct(operation: string, path: string, body: Body, instrId: string, correlationId: string) {
    const r = await this.invoke(operation, { method: 'POST', path, body }, correlationId);
    if (r.kind !== 'ANSWERED') return r;
    const tx = rec(r.value['TxInfAndSts']);
    const status = lookupStatus(TX_STATUS, tx['TxSts']);
    const ref = str(tx['AcctSvcrRef']);
    const at = isoEpoch(tx['AccptncDtTm']);
    const returned = tx['RtrInf'] !== undefined;
    if (status === undefined || ref === undefined || at === undefined || tx['OrgnlInstrId'] !== instrId)
      return malformed();
    // A rejection without a reason code is not a well-formed status report.
    if (status === 'REJECTED' && str(rec(rec(tx['StsRsnInf'])['Rsn'])['Cd']) === undefined) return malformed();
    return {
      kind: 'ANSWERED' as const,
      value: { instructionRef: ref, status, acceptedAtEpochSeconds: at, returned },
    };
  }
}
