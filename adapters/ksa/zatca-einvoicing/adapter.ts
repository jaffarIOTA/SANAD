/**
 * ZATCA — e-invoicing (FATOORA) adapter (CLAUDE.md §5).
 *
 * Implements the e-invoicing port: clearance status and content of one
 * invoice, and a counterparty's cleared-invoice history for decisioning.
 * Fail closed: an invoice the authority does not confirm as CLEARED with a
 * valid stamp is refused, and a drawdown does not proceed on it.
 *
 * Contract: the outcome fields are Fatoora's PUBLISHED clearance / reporting
 * response — `validationResults{infoMessages, warningMessages, errorMessages,
 * status: PASS | WARNING | ERROR}` with rule codes such as BR-KSA-F-06,
 * `clearanceStatus: CLEARED | NOT_CLEARED`, `reportingStatus: REPORTED |
 * NOT_REPORTED`. Fatoora publishes no lookup of an invoice by UUID, so the
 * path, and the `invoice` block (content decoded from the cleared UBL
 * document, UBL element names) are assumptions — see README.md. The trade
 * history call has no public analogue at all and speaks Sanad's vocabulary.
 */

import type { KeyObject } from 'node:crypto';

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type {
  ClearanceStatus,
  CounterpartyTradeHistory,
  EInvoicingProvider,
  InvoiceLineItem,
  InvoiceRef,
  InvoiceValidation,
  TradeHistoryWindow,
} from '../../../core/ports/e-invoicing.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import { money } from '../../../core/kernel/money.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import {
  RailAdapter,
  type RailAdapterConfig,
  arr,
  decimalToMinor,
  idStr,
  int,
  obj,
  own,
  str,
} from '../kernel/rail-adapter.ts';

import { stampVerifies } from './stamp.ts';

export const ZATCA_EINVOICING_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'ZATCA-EINV-DEV-001',
    summary: 'Invoice amounts are decimal strings in the authority’s schema.',
    containment:
      'Converted to minor units by digit manipulation at this boundary; a line that does not parse exactly refuses the whole invoice rather than rounding one line.',
    verificationRef: 'KSA-RAIL-ZATCA-01',
  },
  {
    id: 'ZATCA-EINV-DEV-002',
    summary:
      'The authority’s clearance vocabulary and stamp-verification fields are to be confirmed against the production schema.',
    containment:
      'Only clearanceStatus CLEARED (or, for a simplified invoice, reportingStatus REPORTED) under a validation status of PASS or WARNING with no error message validates; anything else is REJECTED, and an unknown invoice is NOT_FOUND.',
    verificationRef: 'KSA-RAIL-ZATCA-01',
  },
  {
    id: 'ZATCA-EINV-DEV-003',
    summary:
      'The stamp is verified from the invoice QR code (tags 6–8) against the authority keys the institution pins; the tag layout on the read path and the stamping certificate are to be confirmed.',
    containment:
      'A response’s own stamp flag is never read. No pinned key, an unpinned signer, a hash for another invoice or a signature that fails: the stamp is invalid and the invoice validates nothing (SR-016).',
    verificationRef: 'KSA-RAIL-ZATCA-01',
  },
];

/** The institution's pinned authority stamp keys. None configured: no stamp is ever valid. */
export interface ZatcaStampTrust {
  readonly authorityKeys: readonly KeyObject[];
}

/** Fatoora `validationResults.status` values under which an invoice can stand. ERROR never can. */
const VALIDATION_PASSES: Readonly<Record<string, boolean>> = { PASS: true, WARNING: true, ERROR: false };

/**
 * The published Fatoora outcome to the port. `clearanceStatus` (standard, B2B invoices) is
 * CLEARED | NOT_CLEARED; `reportingStatus` (simplified invoices) is REPORTED | NOT_REPORTED.
 * Anything else, or a validation status of ERROR, or any error message, is REJECTED.
 */
export function clearanceOutcome(v: Readonly<Record<string, unknown>>): ClearanceStatus {
  const results = obj(v['validationResults']);
  const passes = own(VALIDATION_PASSES, results?.['status']);
  const errors = arr(results?.['errorMessages']) ?? [];
  if (passes !== true || errors.length > 0) return 'REJECTED';
  if (v['clearanceStatus'] === 'CLEARED') return 'CLEARED';
  if (v['clearanceStatus'] === undefined && v['reportingStatus'] === 'REPORTED') return 'REPORTED';
  return 'REJECTED';
}

/** The rule codes Fatoora returned (BR-KSA-…, BR-…), for the audit trail; never shown as a decision. */
export function ruleCodes(v: Readonly<Record<string, unknown>>): readonly string[] {
  const results = obj(v['validationResults']);
  return ['errorMessages', 'warningMessages', 'infoMessages'].flatMap((k) =>
    (arr(results?.[k]) ?? []).flatMap((m) => {
      const code = str(obj(m)?.['code']);
      return code === undefined ? [] : [code];
    }),
  );
}

export class ZatcaEInvoicingAdapter extends RailAdapter implements EInvoicingProvider {
  readonly vendorName = 'ZATCA';
  readonly capabilities = ['E_INVOICING'] as const;
  readonly deviations = ZATCA_EINVOICING_DEVIATIONS;

  readonly #stampTrust: ZatcaStampTrust;

  constructor(
    config: RailAdapterConfig,
    credentials: CredentialProvider,
    transport: RailTransport,
    stampTrust: ZatcaStampTrust = { authorityKeys: [] },
  ) {
    super(config, credentials, transport);
    this.#stampTrust = stampTrust;
  }

  async validateInvoice(_tenantId: string, ref: InvoiceRef, correlationId: string): Promise<Result<InvoiceValidation>> {
    const r = await this.invoke(
      'einvoice.lookup',
      {
        method: 'GET',
        path: `/v1/invoices/${encodeURIComponent(ref.invoiceUuid)}?hash=${encodeURIComponent(ref.invoiceHash)}`,
      },
      correlationId,
    );
    if (r.kind === 'UNAVAILABLE')
      return reject('OP-DETERMINACY', 'EINVOICING_UNAVAILABLE', 'The e-invoicing authority did not answer', {
        reason: r.reason,
      });
    if (r.kind === 'REFUSED')
      return r.code === 'HTTP_404'
        ? ok({
            ref,
            clearanceStatus: 'NOT_FOUND',
            stampValid: false,
            issuerCr: '',
            recipientCr: '',
            totalAmount: money(0n),
            issueDateGregorian: '',
            lineItems: [],
          })
        : reject('OP-DETERMINACY', 'EINVOICING_REFUSED', 'The e-invoicing authority refused the lookup', {
            code: r.code,
          });
    const v = r.value;
    const status = clearanceOutcome(v);
    // The invoice content, as decoded from the cleared UBL document (field names unconfirmed).
    const invoice = obj(v['invoice']) ?? {};
    // Verified, never taken from the response (SR-016).
    const stampValid = stampVerifies(invoice['qrCode'], ref.invoiceHash, this.#stampTrust.authorityKeys);
    const issuerCr = idStr(obj(invoice['seller'])?.['crNumber']);
    const recipientCr = idStr(obj(invoice['buyer'])?.['crNumber']);
    const total = decimalToMinor(invoice['taxInclusiveAmount']);
    const issued = str(invoice['issueDate']);
    if (issuerCr === undefined || recipientCr === undefined || total === undefined || issued === undefined)
      return reject('OP-DETERMINACY', 'EINVOICE_RESPONSE_MALFORMED', 'The invoice response was not understood');
    const lines: InvoiceLineItem[] = [];
    for (const raw of arr(invoice['invoiceLines']) ?? []) {
      const rec = obj(raw) ?? {};
      const lineNo = int(rec['id']);
      const amount = decimalToMinor(rec['lineExtensionAmount']);
      const code = idStr(rec['itemClassificationCode']);
      if (lineNo === undefined || amount === undefined || code === undefined)
        return reject('OP-DETERMINACY', 'EINVOICE_LINE_MALFORMED', 'An invoice line was not understood', {
          lineNo: String(rec['id']),
        });
      lines.push({
        lineNo,
        descriptionAr: str(rec['itemNameAr']) ?? '',
        descriptionEn: str(rec['itemName']) ?? '',
        goodsClassificationCode: code,
        quantity: str(rec['invoicedQuantity']) ?? '1',
        unitOfMeasure: str(rec['unitCode']) ?? 'EA',
        lineAmount: money(amount),
      });
    }
    return ok({
      ref,
      clearanceStatus: status,
      stampValid,
      issuerCr,
      recipientCr,
      totalAmount: money(total),
      issueDateGregorian: issued,
      lineItems: lines,
    });
  }

  async fetchTradeHistory(
    _tenantId: string,
    registrationNumber: string,
    window: TradeHistoryWindow,
    correlationId: string,
  ): Promise<Result<CounterpartyTradeHistory>> {
    const r = await this.invoke(
      'einvoice.history',
      {
        method: 'POST',
        path: '/v1/trade-history',
        body: { sellerCr: registrationNumber, from: window.fromDateGregorian, to: window.toDateGregorian },
      },
      correlationId,
    );
    if (r.kind !== 'ANSWERED')
      return reject('OP-DETERMINACY', 'EINVOICING_UNAVAILABLE', 'The e-invoicing authority did not answer', {
        reason: r.kind === 'REFUSED' ? r.code : r.reason,
      });
    const v = r.value;
    const count = int(v['clearedInvoiceCount']);
    const total = decimalToMinor(v['totalClearedValue']);
    const buyers = int(v['distinctBuyerCount']);
    if (count === undefined || total === undefined || buyers === undefined || !Array.isArray(v['perBuyer']))
      return reject('OP-DETERMINACY', 'EINVOICE_RESPONSE_MALFORMED', 'The trade history response was not understood');
    const perBuyer = (v['perBuyer'] as unknown[]).flatMap((raw) => {
      const rec = raw as Record<string, unknown>;
      const buyerCr = str(rec['buyerCr']);
      const n = int(rec['invoiceCount']);
      const value = decimalToMinor(rec['totalValue']);
      const days = int(rec['medianDaysToPayment']);
      const cn = int(rec['creditNoteCount']);
      return buyerCr === undefined || n === undefined || value === undefined || days === undefined || cn === undefined
        ? []
        : [{ buyerCr, invoiceCount: n, totalValue: money(value), medianDaysToPayment: days, creditNoteCount: cn }];
    });
    return ok({
      registrationNumber,
      window,
      clearedInvoiceCount: count,
      totalClearedValue: money(total),
      distinctBuyerCount: buyers,
      perBuyer,
    });
  }
}
