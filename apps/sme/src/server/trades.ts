/**
 * Server-side data for the SME surface.
 *
 * Every value the screens render originates here, on the server, and comes
 * from the domain rather than from a shape invented for the view. In
 * particular the pricing handed to `<Money>` is the same `MurabahaPricing` the
 * instrument renders from, so the screen and the contract cannot disagree
 * (SH-15).
 *
 * **The frontend never infers a gate result** (CLAUDE.md §6, SDD §7.9). Where
 * a trade cannot be financed, the reason arrives as a control code from the
 * server; nothing in the browser decides it, and nothing in the browser can
 * talk itself out of it.
 *
 * Today this reads from an in-memory fixture because there is no database yet
 * — see ADR 0001. The shape is what the backend-for-frontend will return, so
 * swapping the source is a change to this file alone.
 */

import { money } from '../../../../core/kernel/money.ts';
import { expectOk } from '../../../../core/kernel/result.ts';
import { type MurabahaPricing, priceMurabaha } from '../../../../core/pricing/murabaha.ts';
import type { ControlCode } from '../../../../core/kernel/result.ts';

export interface TradeSummary {
  readonly transactionId: string;
  /** The invoice number as the counterparty knows it. Latin digits always. */
  readonly invoiceNumber: string;
  readonly buyerNameAr: string;
  readonly buyerNameEn: string;
  readonly issuedGregorian: string;
  readonly issuedHijri: string;
  readonly amountMinorUnits: bigint;
  readonly currency: 'SAR';
  /**
   * Whether this trade can be financed, decided by the server.
   *
   * An unavailable trade is shown, greyed, with its reason — never hidden. The
   * counterparty must be able to understand why something is unavailable
   * (SDD §7.4.1).
   */
  readonly availability:
    | { readonly kind: 'AVAILABLE' }
    | { readonly kind: 'BLOCKED'; readonly control: ControlCode; readonly reason: string };
}

export interface OfferView {
  readonly transactionId: string;
  readonly invoiceNumber: string;
  readonly pricing: MurabahaPricing;
  readonly maturityGregorian: string;
  readonly maturityHijri: string;
}

const CLEARED_TRADES: readonly TradeSummary[] = [
  {
    transactionId: 'txn_01H8K4521',
    invoiceNumber: '452100',
    buyerNameAr: 'شركة الأفق للمواد المحدودة',
    buyerNameEn: 'Al-Ufuq Materials Company Limited',
    issuedGregorian: '14 September 2026',
    issuedHijri: '3 ربيع الأول 1448',
    amountMinorUnits: 18_500_000n,
    currency: 'SAR',
    availability: { kind: 'AVAILABLE' },
  },
  {
    transactionId: 'txn_01H8K4518',
    invoiceNumber: '451892',
    buyerNameAr: 'شركة النهضة التجارية',
    buyerNameEn: 'Al-Nahda Trading Company',
    issuedGregorian: '2 September 2026',
    issuedHijri: '20 صفر 1448',
    amountMinorUnits: 9_200_000n,
    currency: 'SAR',
    availability: {
      kind: 'BLOCKED',
      control: 'SH-10',
      // Wording belongs to the institution's control catalogue, not to a
      // developer. Carried through from the server with its control code.
      reason: 'تم تمويل هذه الفاتورة مسبقًا ولا يمكن تمويلها مرة أخرى.',
    },
  },
  {
    transactionId: 'txn_01H8K4507',
    invoiceNumber: '451604',
    buyerNameAr: 'مؤسسة البناء الحديث',
    buyerNameEn: 'Modern Construction Establishment',
    issuedGregorian: '21 August 2026',
    issuedHijri: '8 صفر 1448',
    amountMinorUnits: 4_100_000n,
    currency: 'SAR',
    availability: {
      kind: 'BLOCKED',
      control: 'SH-11',
      reason: 'تحتوي الفاتورة على أصناف خارج سجل البضائع المعتمد لهذا البرنامج.',
    },
  },
];

export async function availableLimitMinorUnits(): Promise<bigint> {
  return 160_000_000n;
}

export async function listTrades(): Promise<readonly TradeSummary[]> {
  return CLEARED_TRADES;
}

export async function findTrade(transactionId: string): Promise<TradeSummary | undefined> {
  return CLEARED_TRADES.find((t) => t.transactionId === transactionId);
}

/**
 * The offer for a trade.
 *
 * The profit is an amount the server decided at quotation. Nothing here
 * derives it, and there is no proportion anywhere in the returned shape — the
 * view could not render one if it wanted to.
 */
export async function findOffer(transactionId: string): Promise<OfferView | undefined> {
  const trade = await findTrade(transactionId);
  if (trade === undefined || trade.availability.kind !== 'AVAILABLE') return undefined;

  const pricing = expectOk(
    priceMurabaha(money(trade.amountMinorUnits), money(462_500n)),
  );

  return {
    transactionId: trade.transactionId,
    invoiceNumber: trade.invoiceNumber,
    pricing,
    maturityGregorian: '4 January 2027',
    maturityHijri: '25 رجب 1448',
  };
}
