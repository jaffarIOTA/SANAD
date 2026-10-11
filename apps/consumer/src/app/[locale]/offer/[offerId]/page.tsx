/**
 * The offer: exactly what `disclose()` returned plus the platform's APR,
 * in the applicant's language, before acceptance. The acceptance form carries
 * the disclosure version it is accepting; the store refuses a mismatch.
 */

import { notFound, redirect } from 'next/navigation';

import { Disclosure } from '@sanad/design/Disclosure.tsx';
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
        <p className="text-sm font-medium text-brand-strong">{arabic ? 'الخطوة ٢ من ٢' : 'Step 2 of 2'}</p>
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
      <Card>
        <form action={acceptAction} className="flex flex-col gap-5">
          <input type="hidden" name="locale" value={segment} />
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="disclosureVersion" value={stored.offer.disclosureVersion} />
          <label className="flex cursor-pointer items-start gap-3 text-base text-ink">
            <input
              type="checkbox"
              name="confirm"
              value="yes"
              required
              className="mt-0.5 size-5 shrink-0 accent-brand"
            />
            <span>
              {arabic
                ? 'قرأت الإفصاح أعلاه وأفهم إجمالي المبلغ المستحق ومعدل النسبة السنوي.'
                : 'I have read the disclosure above and understand the total amount payable and the APR.'}
            </span>
          </label>
          <div className="flex flex-col gap-3">
            <button
              type="submit"
              className="press inline-flex h-14 w-full items-center justify-center rounded-pill bg-brand px-6 text-base font-semibold text-white hover:bg-brand-deep"
            >
              {arabic ? 'أقبل العرض' : 'Accept offer'}
            </button>
            <a
              href={`/${segment}/apply`}
              className="press inline-flex h-12 w-full items-center justify-center rounded-pill border border-line-strong px-6 text-base font-medium text-brand-strong hover:bg-brand-wash"
            >
              {arabic ? 'تغيير المبلغ أو المدة' : 'Change amount or term'}
            </a>
          </div>
          <p className="text-center text-sm text-ink-quiet">
            {arabic
              ? 'نحتفظ بسجل للإفصاح الذي عُرض عليك بالضبط.'
              : 'We keep a record of exactly the disclosure you were shown.'}
          </p>
        </form>
      </Card>
    </div>
  );
}
