/**
 * A reference to the real trade an application is about.
 *
 * Trade-first products (a Murabaha over a cleared invoice) start from one of
 * these instead of from an amount. The engine holds the reference; what a
 * product does with it — validate it, buy the goods it names, register it so
 * it cannot be financed twice — is the product module's business.
 */
export interface TradeReference {
  readonly type: 'CLEARED_INVOICE' | 'PURCHASE_ORDER';
  /** Unique identifier from the e-invoicing authority, where the trade is an invoice. */
  readonly invoiceUuid?: string;
  readonly invoiceHash?: string;
  /** Verified registration numbers. Distinctness is matched on these, not names. */
  readonly issuerCr: string;
  readonly recipientCr: string;
}
