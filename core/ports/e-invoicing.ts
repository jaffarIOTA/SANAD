/**
 * E-invoicing port.
 *
 * Designed as a generic contract from the first commit rather than as an
 * integration with one authority. Every jurisdiction adopting mandatory
 * structured e-invoicing becomes a market where the same underwriting and
 * evidence model works, needing only a new adapter (SDD §3.8, strategic note).
 *
 * This is the single most consequential input in the system. A cleared invoice
 * naming the institution as recipient, combined with a delivery record, is
 * third-party evidence of a real trade — the Board verifies it rather than
 * taking the institution's word for it.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';

export interface InvoiceRef {
  readonly invoiceUuid: string;
  readonly invoiceHash: string;
}

export type ClearanceStatus = 'CLEARED' | 'REPORTED' | 'REJECTED' | 'NOT_FOUND';

export interface InvoiceLineItem {
  readonly lineNo: number;
  readonly descriptionAr: string;
  readonly descriptionEn: string;
  /** Classification code, screened line by line against the goods register. */
  readonly goodsClassificationCode: string;
  readonly quantity: string;
  readonly unitOfMeasure: string;
  readonly lineAmount: Money;
}

export interface InvoiceValidation {
  readonly ref: InvoiceRef;
  readonly clearanceStatus: ClearanceStatus;
  /** Cryptographic stamp verified against the authority. */
  readonly stampValid: boolean;
  readonly issuerCr: string;
  readonly recipientCr: string;
  readonly totalAmount: Money;
  readonly issueDateGregorian: string;
  readonly lineItems: readonly InvoiceLineItem[];
}

export interface TradeHistoryWindow {
  readonly fromDateGregorian: string;
  readonly toDateGregorian: string;
}

export interface CounterpartyTradeHistory {
  readonly registrationNumber: string;
  readonly window: TradeHistoryWindow;
  readonly clearedInvoiceCount: number;
  readonly totalClearedValue: Money;
  readonly distinctBuyerCount: number;
  readonly perBuyer: readonly {
    readonly buyerCr: string;
    readonly invoiceCount: number;
    readonly totalValue: Money;
    readonly medianDaysToPayment: number;
    readonly creditNoteCount: number;
  }[];
}

export interface EInvoicingProvider {
  /** Fail closed. A drawdown does not proceed on an unvalidated invoice. */
  validateInvoice(tenantId: string, ref: InvoiceRef, correlationId: string): Promise<Result<InvoiceValidation>>;

  fetchTradeHistory(
    tenantId: string,
    registrationNumber: string,
    window: TradeHistoryWindow,
    correlationId: string,
  ): Promise<Result<CounterpartyTradeHistory>>;
}
