/**
 * Dashboard data for the operations workbench.
 *
 * The dashboard's job is to answer two questions for whoever opens it: what
 * needs my attention, and how can work arrive here at all. Hence a review
 * queue and a channel panel.
 *
 * The channel panel is not decoration. Three of the four intake routes are
 * live; the two servicing capabilities beneath them are not, and one of those
 * is excluded from this phase by the specification rather than by us. Showing
 * that on the operating surface — rather than only in a document nobody opens
 * — is how a governance position survives contact with delivery pressure.
 *
 * Fixture-backed for now. See ADR 0001.
 */

import {
  CHANNEL_POLICIES,
  ORIGINATION_CHANNELS,
  type OriginationChannel,
} from '@sanad/core/origination/channel.ts';
import type { RequestState } from '@sanad/core/origination/request.ts';

export type Readiness =
  | { readonly kind: 'LIVE' }
  /** Built, but waiting on something outside engineering. */
  | { readonly kind: 'BLOCKED'; readonly on: string }
  /** Excluded from this phase by the specification. */
  | { readonly kind: 'EXCLUDED_THIS_PHASE'; readonly basis: string };

export interface ChannelCard {
  readonly channel: OriginationChannel;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly summaryEn: string;
  readonly summaryAr: string;
  readonly requiresFourEyes: boolean;
  readonly readiness: Readiness;
  readonly openRequests: number;
}

export interface QueueItem {
  readonly requestId: string;
  readonly channel: OriginationChannel;
  readonly counterpartyEn: string;
  readonly counterpartyAr: string;
  readonly amountMinorUnits: bigint;
  readonly state: RequestState;
  readonly makerPrincipalId: string;
  readonly waitingHours: number;
}

const QUEUE: readonly QueueItem[] = [
  {
    requestId: 'req_01J2A7',
    channel: 'MAKER_CHECKER',
    counterpartyEn: 'Al-Ufuq Materials Company Limited',
    counterpartyAr: 'شركة الأفق للمواد المحدودة',
    amountMinorUnits: 18_500_000n,
    state: 'AWAITING_REVIEW',
    makerPrincipalId: 'stf-maker-01',
    waitingHours: 2,
  },
  {
    requestId: 'req_01J2A9',
    channel: 'PARTNER_API',
    counterpartyEn: 'Modern Construction Establishment',
    counterpartyAr: 'مؤسسة البناء الحديث',
    amountMinorUnits: 7_400_000n,
    state: 'AWAITING_REVIEW',
    makerPrincipalId: 'ptr-erp-north',
    waitingHours: 6,
  },
  {
    requestId: 'req_01J2B1',
    channel: 'MAKER_CHECKER',
    counterpartyEn: 'Al-Nahda Trading Company',
    counterpartyAr: 'شركة النهضة التجارية',
    amountMinorUnits: 3_150_000n,
    state: 'RETURNED_TO_MAKER',
    makerPrincipalId: 'stf-maker-02',
    waitingHours: 26,
  },
];

const COPY: Readonly<
  Record<
    OriginationChannel,
    { titleEn: string; titleAr: string; summaryEn: string; summaryAr: string; readiness: Readiness }
  >
> = {
  MAKER_CHECKER: {
    titleEn: 'Keyed by operations',
    titleAr: 'إدخال من قبل العمليات',
    summaryEn: 'An operator keys the request against a cleared invoice; a second operator reviews and approves it.',
    summaryAr: 'يُدخل الموظف الطلب مقابل فاتورة معتمدة، ويراجعه ويعتمده موظف آخر.',
    readiness: { kind: 'LIVE' },
  },
  COUNTERPARTY_SELF: {
    titleEn: 'Counterparty portal',
    titleAr: 'بوابة العميل',
    summaryEn: 'The counterparty selects one of its own cleared invoices and requests finance against it.',
    summaryAr: 'يختار العميل إحدى فواتيره المعتمدة ويطلب التمويل مقابلها.',
    readiness: { kind: 'LIVE' },
  },
  PARTNER_API: {
    titleEn: 'Partner API',
    titleAr: 'واجهة الشركاء البرمجية',
    summaryEn: 'An integrating system posts a request under its own credential. Same gates, same evidence.',
    summaryAr: 'يرسل نظام متكامل طلبًا باستخدام بيانات اعتماده. نفس الضوابط ونفس الأدلة.',
    readiness: { kind: 'LIVE' },
  },
  EMBEDDED_AGGREGATOR: {
    titleEn: 'Embedded — aggregator nomination',
    titleAr: 'التمويل المدمج — ترشيح من المنصة',
    summaryEn:
      'An aggregator nominates a merchant in its network. Requires a mandate from the merchant and four-eyes review.',
    summaryAr: 'ترشّح المنصة أحد التجار لديها. يتطلب تفويضًا من التاجر ومراجعة من شخصين.',
    readiness: {
      kind: 'BLOCKED',
      on: 'What goods are bought and sold. A Murabaha needs a real trade; working capital with no underlying purchase has no seller and no goods. Board question — see docs/open-questions.md.',
    },
  },
};

export async function channelCards(): Promise<readonly ChannelCard[]> {
  return ORIGINATION_CHANNELS.map((channel) => ({
    channel,
    ...COPY[channel],
    requiresFourEyes: CHANNEL_POLICIES[channel].requiresFourEyes,
    openRequests: QUEUE.filter(
      (q) => q.channel === channel && q.state === 'AWAITING_REVIEW',
    ).length,
  }));
}

export async function reviewQueue(): Promise<readonly QueueItem[]> {
  return [...QUEUE].sort((a, b) => b.waitingHours - a.waitingHours);
}

// -- Capabilities that are not intake channels --------------------------------

export interface CapabilityCard {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly summaryEn: string;
  readonly readiness: Readiness;
}

export async function servicingCapabilities(): Promise<readonly CapabilityCard[]> {
  return [
    {
      id: 'EMBEDDED_COLLECTION',
      titleEn: 'Embedded collection schedules',
      titleAr: 'جداول التحصيل المدمجة',
      summaryEn:
        'Collect through the aggregator: a share of daily settlement, a fixed daily amount, or a weekly, fortnightly or monthly sweep.',
      readiness: {
        kind: 'BLOCKED',
        on: 'Determinacy. A share-of-sales sweep has no determinate final payment date, and SH-03 requires payment dates to be determinate before a contract can execute. Resolvable with a fixed backstop maturity — needs a Board ruling.',
      },
    },
    {
      id: 'COMMODITY_BROKER',
      titleEn: 'Commodity broker integration',
      titleAr: 'الربط مع وسطاء السلع',
      summaryEn:
        'Buying and selling metals through a commodity platform to generate a deferred-payment obligation.',
      readiness: {
        kind: 'EXCLUDED_THIS_PHASE',
        basis:
          'This is organised tawarruq. SDD §1.5 and PR-X2 exclude it from Phase 1 entirely; admissible later only on an explicit Board ruling, with enforced conditions and a volume cap.',
      },
    },
  ];
}
