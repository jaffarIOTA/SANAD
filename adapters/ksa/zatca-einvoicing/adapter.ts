/**
 * ZATCA — e-invoicing (FATOORA) adapter (CLAUDE.md §5).
 *
 * Implements the e-invoicing port: clearance status and content of one
 * invoice, and a counterparty's cleared-invoice history for decisioning.
 * Fail closed: an invoice the authority does not confirm as CLEARED with a
 * valid stamp is refused, and a drawdown does not proceed on it.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { ClearanceStatus, CounterpartyTradeHistory, EInvoicingProvider, InvoiceLineItem, InvoiceRef, InvoiceValidation, TradeHistoryWindow } from '../../../core/ports/e-invoicing.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import { money } from '../../../core/kernel/money.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, bool, decimalToMinor, int, str } from '../kernel/rail-adapter.ts';

export const ZATCA_EINVOICING_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'ZATCA-EINV-DEV-001',
    summary: 'Invoice amounts are decimal strings in the authority’s schema.',
    containment: 'Converted to minor units by digit manipulation at this boundary; a line that does not parse exactly refuses the whole invoice rather than rounding one line.',
    verificationRef: 'KSA-RAIL-ZATCA-01',
  },
  {
    id: 'ZATCA-EINV-DEV-002',
    summary: 'The authority’s clearance vocabulary and stamp-verification fields are to be confirmed against the production schema.',
    containment: 'Anything not literally CLEARED or REPORTED maps to REJECTED or NOT_FOUND; an unknown status never validates an invoice.',
    verificationRef: 'KSA-RAIL-ZATCA-01',
  },
];

const STATUS: Readonly<Record<string, ClearanceStatus>> = { CLEARED: 'CLEARED', REPORTED: 'REPORTED', REJECTED: 'REJECTED', NOT_FOUND: 'NOT_FOUND' };

export class ZatcaEInvoicingAdapter extends RailAdapter implements EInvoicingProvider {
  readonly vendorName = 'ZATCA';
  readonly capabilities = ['E_INVOICING'] as const;
  readonly deviations = ZATCA_EINVOICING_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async validateInvoice(_tenantId: string, ref: InvoiceRef, correlationId: string): Promise<Result<InvoiceValidation>> {
    const r = await this.invoke('einvoice.lookup', { method: 'GET', path: `/v1/invoices/${encodeURIComponent(ref.invoiceUuid)}?hash=${encodeURIComponent(ref.invoiceHash)}` }, correlationId);
    if (r.kind === 'UNAVAILABLE') return reject('OP-DETERMINACY', 'EINVOICING_UNAVAILABLE', 'The e-invoicing authority did not answer', { reason: r.reason });
    if (r.kind === 'REFUSED') return r.code === 'HTTP_404'
      ? ok({ ref, clearanceStatus: 'NOT_FOUND', stampValid: false, issuerCr: '', recipientCr: '', totalAmount: money(0n), issueDateGregorian: '', lineItems: [] })
      : reject('OP-DETERMINACY', 'EINVOICING_REFUSED', 'The e-invoicing authority refused the lookup', { code: r.code });
    const v = r.value;
    const status = STATUS[String(v['clearanceStatus'])] ?? 'REJECTED';
    const stampValid = bool(v['stampValid']) ?? false;
    const issuerCr = str(v['sellerCr']); const recipientCr = str(v['buyerCr']); const total = decimalToMinor(v['totalAmount']); const issued = str(v['issueDate']);
    if (issuerCr === undefined || recipientCr === undefined || total === undefined || issued === undefined) return reject('OP-DETERMINACY', 'EINVOICE_RESPONSE_MALFORMED', 'The invoice response was not understood');
    const lines: InvoiceLineItem[] = [];
    for (const raw of Array.isArray(v['lines']) ? (v['lines'] as unknown[]) : []) {
      const rec = raw as Record<string, unknown>;
      const lineNo = int(rec['lineNo']); const amount = decimalToMinor(rec['amount']); const code = str(rec['classificationCode']);
      if (lineNo === undefined || amount === undefined || code === undefined) return reject('OP-DETERMINACY', 'EINVOICE_LINE_MALFORMED', 'An invoice line was not understood', { lineNo: String(rec['lineNo']) });
      lines.push({ lineNo, descriptionAr: str(rec['descriptionAr']) ?? '', descriptionEn: str(rec['descriptionEn']) ?? '', goodsClassificationCode: code, quantity: str(rec['quantity']) ?? '1', unitOfMeasure: str(rec['unit']) ?? 'EA', lineAmount: money(amount) });
    }
    return ok({ ref, clearanceStatus: status, stampValid, issuerCr, recipientCr, totalAmount: money(total), issueDateGregorian: issued, lineItems: lines });
  }

  async fetchTradeHistory(_tenantId: string, registrationNumber: string, window: TradeHistoryWindow, correlationId: string): Promise<Result<CounterpartyTradeHistory>> {
    const r = await this.invoke('einvoice.history', { method: 'POST', path: '/v1/trade-history', body: { sellerCr: registrationNumber, from: window.fromDateGregorian, to: window.toDateGregorian } }, correlationId);
    if (r.kind !== 'ANSWERED') return reject('OP-DETERMINACY', 'EINVOICING_UNAVAILABLE', 'The e-invoicing authority did not answer', { reason: r.kind === 'REFUSED' ? r.code : r.reason });
    const v = r.value;
    const count = int(v['clearedInvoiceCount']); const total = decimalToMinor(v['totalClearedValue']); const buyers = int(v['distinctBuyerCount']);
    if (count === undefined || total === undefined || buyers === undefined || !Array.isArray(v['perBuyer'])) return reject('OP-DETERMINACY', 'EINVOICE_RESPONSE_MALFORMED', 'The trade history response was not understood');
    const perBuyer = (v['perBuyer'] as unknown[]).flatMap((raw) => {
      const rec = raw as Record<string, unknown>;
      const buyerCr = str(rec['buyerCr']); const n = int(rec['invoiceCount']); const value = decimalToMinor(rec['totalValue']); const days = int(rec['medianDaysToPayment']); const cn = int(rec['creditNoteCount']);
      return buyerCr === undefined || n === undefined || value === undefined || days === undefined || cn === undefined ? [] : [{ buyerCr, invoiceCount: n, totalValue: money(value), medianDaysToPayment: days, creditNoteCount: cn }];
    });
    return ok({ registrationNumber, window, clearedInvoiceCount: count, totalClearedValue: money(total), distinctBuyerCount: buyers, perBuyer });
  }
}
