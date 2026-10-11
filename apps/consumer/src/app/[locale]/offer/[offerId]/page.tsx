/**
 * The offer: exactly what `disclose()` returned plus the platform's APR,
 * in the applicant's language, before acceptance. The acceptance form carries
 * the disclosure version it is accepting; the store refuses a mismatch.
 *
 * The acceptance follows the commit step of the reference lending and BNPL
 * apps: the action bar stays at the bottom of the screen while the disclosure
 * is read, the acknowledgement sits against the button it governs, the total
 * payable is restated beside the commitment, and the button reads as inactive
 * until the acknowledgement is ticked. Changing the request moves up to the
 * page heading, out of the commitment's way.
 */

import { notFound, redirect } from 'next/navigation';

import type { Money } from '@sanad/core/kernel/money.ts';

import { Disclosure } from '@sanad/design/Disclosure.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { Card, ControlRejection, DualDate } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { acceptAction } from '../../../../server/actions.ts';
import { explain } from '../../../../server/explain.ts';
import { currentSession } from '../../../../server/session.ts';
import { acceptanceFor, findOffer } from '../../../../server/store.ts';

export default async function OfferPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly offerId: string }>;
  readonly searchParams: Promise<{ readonly refused?: string; readonly control?: string }>;
}) {
  const { locale: segment, offerId } = await params;
  const { refused, control } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const session = await currentSession();
  if (session === undefined) redirect(`/${segment}`);
  const stored = findOffer(offerId);
  if (stored === undefined || stored.applicantRef !== session.applicantRef) notFound();
  if (acceptanceFor(offerId) !== undefined) redirect(`/${segment}/offer/${offerId}/accepted`);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-brand-strong">{arabic ? 'الخطوة ٢ من ٢' : 'Step 2 of 2'}</p>
          <a
            href={`/${segment}/apply`}
            className="inline-flex min-h-tap items-center text-sm font-medium text-brand-strong underline-offset-4 hover:underline"
          >
            {arabic ? 'تغيير المبلغ أو المدة' : 'Change amount or term'}
          </a>
        </div>
        <h1 className="text-h1 font-semibold text-heading">{arabic ? 'عرضك' : 'Your offer'}</h1>
        <p className="text-lede text-ink-quiet">
          {arabic
            ? 'راجع الأرقام أدناه. العرض محجوز لك سبعة أيام.'
            : 'Check the figures below. We hold this offer for seven days.'}
        </p>
      </header>
      {refused !== undefined ? (
        <ControlRejection
          control={control ?? 'OP-DETERMINACY'}
          explanation={explain(refused, arabic)}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}
      <Disclosure offer={stored.offer} locale={locale} />
      <Card>
        <dl className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-ink-quiet">{arabic ? 'آخر قسط مستحق في' : 'Final payment due'}</dt>
            <dd>
              <DualDate gregorian={stored.maturityDateGregorian} hijri={stored.maturityDateHijri} locale={locale} />
            </dd>
          </div>
          <div className="flex flex-col items-end gap-1">
            <dt className="text-sm text-ink-quiet">{arabic ? 'المنتج' : 'Product'}</dt>
            <dd className="identifier text-sm text-ink">{stored.productCode}</dd>
          </div>
        </dl>
      </Card>
      <p className="text-center text-sm text-ink-quiet">
        {arabic
          ? 'نحتفظ بسجل للإفصاح الذي عُرض عليك بالضبط.'
          : 'We keep a record of exactly the disclosure you were shown.'}
      </p>

      <AcceptBar
        segment={segment}
        offerId={offerId}
        disclosureVersion={stored.offer.disclosureVersion}
        total={stored.offer.disclosure.totalPayable}
        locale={locale}
      />
    </div>
  );
}

/** The commit step, pinned to the bottom of the screen while the disclosure above is read. */
function AcceptBar({
  segment,
  offerId,
  disclosureVersion,
  total,
  locale,
}: {
  readonly segment: string;
  readonly offerId: string;
  readonly disclosureVersion: string;
  /** Restated beside the commitment: the disclosed figure, formatted, never derived. */
  readonly total: Money;
  readonly locale: 'ar-SA' | 'en-SA';
}) {
  const arabic = locale === 'ar-SA';
  return (
    <form
      action={acceptAction}
      className="accept-bar sticky bottom-0 -mx-4 flex flex-col gap-4 border-t border-line bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.12)]"
    >
      <input type="hidden" name="locale" value={segment} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="disclosureVersion" value={disclosureVersion} />
      <label className="flex cursor-pointer items-start gap-3 text-sm text-ink">
        <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 size-5 shrink-0 accent-brand" />
        <span>
          {arabic
            ? 'قرأت الإفصاح أعلاه وأفهم إجمالي المبلغ المستحق ومعدل النسبة السنوي.'
            : 'I have read the disclosure above and understand the total amount payable and the APR.'}
        </span>
      </label>
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs text-ink-quiet">{arabic ? 'إجمالي المبلغ المستحق' : 'Total payable'}</span>
          <span className="whitespace-nowrap text-base font-semibold text-ink tabular-nums">
            <bdi>{formatMinorUnits(total, defaultNumerals(locale))}</bdi>{' '}
            <span className="text-xs font-normal text-ink-quiet">{total.currency}</span>
          </span>
        </div>
        <button
          type="submit"
          className="accept-submit press ms-auto inline-flex h-14 flex-1 items-center justify-center rounded-pill bg-brand px-6 text-base font-semibold text-white hover:bg-brand-deep"
        >
          {arabic ? 'أقبل العرض' : 'Accept offer'}
        </button>
      </div>
    </form>
  );
}
