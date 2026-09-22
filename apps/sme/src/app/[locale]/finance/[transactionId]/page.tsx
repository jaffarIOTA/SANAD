/**
 * Step two — the offer.
 *
 * Cost and profit shown separately and explicitly, as amounts. The total is
 * the total and it will never change. No rate appears anywhere, because none
 * exists — and the component rendering these figures has no prop through which
 * one could be passed (FP-03, SH-15).
 *
 * Both calendars appear because the maturity date has contractual effect
 * (NFR-08). Both values come from storage; neither is converted here.
 *
 * The contract itself is then read in an embedded viewer — never downloaded,
 * never summarised (SDD §7.7). That viewer is not built yet: it needs the
 * document platform, which is blocked on the licence question. The seam is
 * marked below rather than faked, because a placeholder that looks like a
 * signed contract is worse than an honest gap.
 */

import { notFound } from 'next/navigation';

import { Money } from '../../../design/Money.tsx';
import { Card, DualDate } from '../../../design/primitives.tsx';
import { STRINGS } from '../../../i18n/strings.ts';
import { findOffer } from '../../../server/trades.ts';

const LOCALE = 'ar-SA' as const;

export default async function OfferPage({
  params,
}: {
  readonly params: Promise<{ readonly transactionId: string }>;
}) {
  const { transactionId } = await params;
  const t = STRINGS[LOCALE];

  // The server decides whether an offer exists. The browser does not infer it
  // from a gate, a state name or anything else it happens to hold.
  const offer = await findOffer(transactionId);
  if (offer === undefined) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <a href="/" className="text-sm text-brand-deep underline">
          {t.back}
        </a>
        <h1 className="mt-2 text-lg font-semibold">{t.murabahaOffer}</h1>
        <p className="mt-1 text-sm text-ink-quiet">
          {t.invoice} <span className="identifier">{offer.invoiceNumber}</span>
        </p>
      </div>

      <Card>
        <Money
          pricing={offer.pricing}
          locale={LOCALE}
          labels={{ cost: t.cost, profit: t.profit, total: t.total }}
        />
        <p className="mt-3 text-xs text-ink-quiet">{t.disclosureNote}</p>
      </Card>

      <Card>
        <p className="text-sm text-ink-quiet">{t.maturityDate}</p>
        <div className="mt-1">
          <DualDate
            gregorian={offer.maturityGregorian}
            hijri={offer.maturityHijri}
            locale={LOCALE}
          />
        </div>
      </Card>

      {/*
        The embedded contract viewer belongs here: read in place, scroll
        completion tracked, per-clause acknowledgement where the Board requires
        it, and the exact rendition presented is the rendition hashed and
        sealed. Blocked on the document platform licence — see
        adapters/nutrient/README.md. Deliberately not stubbed with something
        that resembles a contract.
      */}
      <div className="rounded-card border border-dashed border-line-strong p-4 text-sm text-ink-quiet">
        {t.readContract}
      </div>
    </div>
  );
}
