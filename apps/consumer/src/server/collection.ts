/**
 * How the shopper pays their instalments: the channels offered, and the
 * reference of the authority each needs.
 *
 * The channels are the tenant's term sheet (`collectionMethods`) narrowed to
 * those its jurisdiction carries (`collectionChannels` in the jurisdiction
 * profile): a Saudi shopper is offered SADAD, card, Open Banking and their own
 * account; a UAE shopper would be offered direct debit (UAEDDS), card, Open
 * Finance and their own account. A scheme never appears outside its country.
 *
 * The mandate reference points at the rail's own record of the shopper's
 * authority: a SADAD bill account under the institution's biller, a card token
 * from the payments hub, an Open Banking consent, the shopper's own account.
 * Those journeys belong to the rails and are not built; in the synthetic
 * demonstration each is a labelled stand-in derived from the applicant
 * reference (one containing `insufficient` makes every collection return).
 */
import { loadTenantJurisdiction } from '@sanad/config/loader.ts';
import type { CollectionChannel, JurisdictionCode } from '@sanad/core/jurisdiction/profile.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';

import { TENANT } from './engine.ts';

export interface OfferedChannel {
  readonly channel: CollectionChannel;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly noteEn: string;
  readonly noteAr: string;
}

type Labels = Omit<OfferedChannel, 'channel'>;

/** Each country's own words for its own schemes. */
const LABELS: Readonly<Record<JurisdictionCode, Partial<Record<CollectionChannel, Labels>>>> = {
  SA: {
    BILL_PRESENTMENT: {
      labelEn: 'SADAD bill',
      labelAr: 'فاتورة سداد',
      noteEn: 'Each instalment appears as a SADAD bill in your banking app.',
      noteAr: 'يظهر كل قسط فاتورةً في سداد ضمن تطبيق بنكك.',
    },
    CARD: {
      labelEn: 'Card (mada, Visa, Mastercard)',
      labelAr: 'البطاقة (مدى، فيزا، ماستركارد)',
      noteEn: 'Your card is charged on each due date.',
      noteAr: 'تُخصم البطاقة في تاريخ استحقاق كل قسط.',
    },
    PAYMENT_INITIATION: {
      labelEn: 'From your bank account (Open Banking)',
      labelAr: 'من حسابك البنكي (المصرفية المفتوحة)',
      noteEn: 'You consent once; each instalment is paid from your account on its due date.',
      noteAr: 'توافق مرة واحدة، ويُدفع كل قسط من حسابك في تاريخ استحقاقه.',
    },
    OWN_ACCOUNT: {
      labelEn: 'From your account with us',
      labelAr: 'من حسابك لدينا',
      noteEn: 'We debit your account with us on each due date.',
      noteAr: 'نخصم القسط من حسابك لدينا في تاريخ استحقاقه.',
    },
  },
  AE: {
    DIRECT_DEBIT: {
      labelEn: 'Direct debit (UAEDDS)',
      labelAr: 'الخصم المباشر (نظام الإمارات للخصم المباشر)',
      noteEn: 'Each instalment is debited from your bank account under a direct-debit mandate.',
      noteAr: 'يُخصم كل قسط من حسابك البنكي بموجب تفويض خصم مباشر.',
    },
    CARD: {
      labelEn: 'Card',
      labelAr: 'البطاقة',
      noteEn: 'Your card is charged on each due date.',
      noteAr: 'تُخصم البطاقة في تاريخ استحقاق كل قسط.',
    },
    PAYMENT_INITIATION: {
      labelEn: 'From your bank account (Open Finance)',
      labelAr: 'من حسابك البنكي (التمويل المفتوح)',
      noteEn: 'You consent once; each instalment is paid from your account on its due date.',
      noteAr: 'توافق مرة واحدة، ويُدفع كل قسط من حسابك في تاريخ استحقاقه.',
    },
    OWN_ACCOUNT: {
      labelEn: 'From your account with us',
      labelAr: 'من حسابك لدينا',
      noteEn: 'We debit your account with us on each due date.',
      noteAr: 'نخصم القسط من حسابك لدينا في تاريخ استحقاقه.',
    },
  },
};

/** The channels this shopper may choose, in the term sheet's order. */
export async function offeredChannels(atEpochSeconds: bigint): Promise<readonly OfferedChannel[]> {
  const profile = loadTenantJurisdiction(TENANT);
  if (!profile.ok) return [];
  const catalogue = (await resolveProductCatalogue(TENANT, atEpochSeconds)).catalogue;
  const entry = catalogue.ok ? entryFor(catalogue.value, 'bnpl', 'prg-0001', atEpochSeconds) : undefined;
  const terms = entry !== undefined && entry.ok ? bnpl.validateTerms(entry.value.terms) : undefined;
  if (terms === undefined || !terms.ok) return [];
  const labels = LABELS[profile.value.code];
  return terms.value.collectionMethods.flatMap((channel) => {
    const l = labels[channel];
    return profile.value.collectionChannels[channel] === undefined || l === undefined ? [] : [{ channel, ...l }];
  });
}

/** The demonstration's stand-in for the rail's record of the shopper's authority. Labelled; never real. */
export function demonstrationMandateRef(channel: CollectionChannel, applicantRef: string): string {
  const prefix: Record<CollectionChannel, string> = {
    BILL_PRESENTMENT: 'demo-bill-acct',
    DIRECT_DEBIT: 'demo-dd-mandate',
    CARD: 'demo-card-token',
    PAYMENT_INITIATION: 'demo-pis-consent',
    OWN_ACCOUNT: 'demo-own-acct',
  };
  return `${prefix[channel]}-${applicantRef}`.slice(0, 120);
}
