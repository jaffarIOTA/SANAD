/**
 * Cleared invoices available to finance.
 *
 * **The journey starts here, not at an amount.** §6 is explicit: the drawdown
 * journey begins by selecting a real invoice or purchase order, and there is
 * no free-text amount input. That is not a usability preference — it is the
 * Shariah structure made visible. A Murabaha finances the purchase of
 * identified goods; an amount typed into a box is a loan with extra steps.
 *
 * So the amount is a *property of the selected trade*, read from the cleared
 * invoice, and never keyed. The operator chooses what is being financed; the
 * figure follows.
 *
 * In production these come from the e-invoicing authority through an adapter,
 * already cleared and already hashed. This is the development substitute,
 * named so it is obvious in a diff and in a deployment.
 */

import { money, type Money } from '@sanad/core/kernel/money.ts';

export interface ClearedInvoice {
  /** The e-invoicing authority's identifier. The key SH-10 is unique on. */
  readonly invoiceUuid: string;
  /** The number a human recognises it by. */
  readonly invoiceNumber: string;
  /** SHA-256 of the cleared document. */
  readonly invoiceHash: string;

  readonly issuerName: string;
  readonly issuerCr: string;
  readonly recipientName: string;
  readonly recipientCr: string;

  /** Read from the invoice. Never typed by an operator. */
  readonly amount: Money;

  readonly issuedGregorian: string;
  readonly issuedHijri: string;
  /** What is actually being bought. A Murabaha finances goods, not a sum. */
  readonly goodsDescription: string;
  readonly goodsDescriptionAr: string;
}

const DEVELOPMENT_INVOICES: readonly ClearedInvoice[] = [
  {
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000101',
    invoiceNumber: '452201',
    invoiceHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    issuerName: 'Al-Ufuq Materials Company Limited',
    issuerCr: '1010000002',
    recipientName: 'Rawabi Industrial Supplies Establishment',
    recipientCr: '7001000001',
    amount: money(24_500_000n),
    issuedGregorian: '18 September 2026',
    issuedHijri: '٦ ربيع الآخر ١٤٤٨',
    goodsDescription: 'Structural steel sections, 120 tonnes',
    goodsDescriptionAr: 'مقاطع حديد إنشائي، ١٢٠ طناً',
  },
  {
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000102',
    invoiceNumber: '452214',
    invoiceHash: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
    issuerName: 'Najd Logistics Company',
    issuerCr: '1010000044',
    recipientName: 'Tamam Foodstuff Trading Company',
    recipientCr: '7001000019',
    amount: money(8_750_000n),
    issuedGregorian: '20 September 2026',
    issuedHijri: '٨ ربيع الآخر ١٤٤٨',
    goodsDescription: 'Refrigerated transport units, 4 units',
    goodsDescriptionAr: 'وحدات نقل مبرّدة، ٤ وحدات',
  },
  {
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000103',
    invoiceNumber: '452230',
    invoiceHash: 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2',
    issuerName: 'Bahr Al-Khaleej Shipping Establishment',
    issuerCr: '1010000077',
    recipientName: 'Rawabi Industrial Supplies Establishment',
    recipientCr: '7001000001',
    amount: money(51_200_000n),
    issuedGregorian: '21 September 2026',
    issuedHijri: '٩ ربيع الآخر ١٤٤٨',
    goodsDescription: 'Marine freight containers, 30 units',
    goodsDescriptionAr: 'حاويات شحن بحري، ٣٠ وحدة',
  },
  {
    // Deliberately the same issuer and recipient. Selecting it must be
    // refused by SH-08 — a party cannot sell to itself — and the screen shows
    // that refusal rather than hiding the invoice.
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000104',
    invoiceNumber: '452241',
    invoiceHash: 'd4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3',
    issuerName: 'Tamam Foodstuff Trading Company',
    issuerCr: '7001000019',
    recipientName: 'Tamam Foodstuff Trading Company',
    recipientCr: '7001000019',
    amount: money(3_100_000n),
    issuedGregorian: '21 September 2026',
    issuedHijri: '٩ ربيع الآخر ١٤٤٨',
    goodsDescription: 'Packaging materials',
    goodsDescriptionAr: 'مواد تغليف',
  },
];

export function listClearedInvoices(): readonly ClearedInvoice[] {
  return DEVELOPMENT_INVOICES;
}

export function findClearedInvoice(invoiceUuid: string): ClearedInvoice | undefined {
  return DEVELOPMENT_INVOICES.find((i) => i.invoiceUuid === invoiceUuid);
}

/**
 * Why an invoice cannot be financed.
 *
 * Returned so the screen can show the invoice *and* say why it is unavailable.
 * Hiding it would be tidier and worse: an operator who cannot see an invoice
 * assumes it was never cleared, and raises a ticket about the wrong system.
 */
export type Unavailable =
  /** SH-10. Already financed; the registry is never purged, even after settlement. */
  | { readonly control: 'SH-10'; readonly financedAs: string }
  /** SH-08. The same legal entity on both sides is 'inah. */
  | { readonly control: 'SH-08' };

export function unavailableReason(
  invoice: ClearedInvoice,
  financed: ReadonlyMap<string, string>,
): Unavailable | undefined {
  const financedAs = financed.get(invoice.invoiceUuid);
  if (financedAs !== undefined) return { control: 'SH-10', financedAs };

  // Matched on registration number, never on name. Two names that differ are
  // not two parties.
  if (invoice.issuerCr === invoice.recipientCr) return { control: 'SH-08' };

  return undefined;
}
