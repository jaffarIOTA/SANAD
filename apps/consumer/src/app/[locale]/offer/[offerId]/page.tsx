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
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-h1 font-semibold text-heading">{arabic ? 'عرضك' : 'Your offer'}</h1>
        <p className="mt-2 text-[15px] text-ink-quiet">
          {arabic
            ? 'هذا ما ستدفعه، بالضبط. لا شيء يُضاف لاحقاً.'
            : 'This is what you will pay, exactly. Nothing is added later.'}
        </p>
      </div>
      {refused !== undefined ? (
        <ControlRejection
          control={control ?? 'OP-DETERMINACY'}
          explanation={explain(refused, arabic)}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}
      <Disclosure offer={stored.offer} locale={locale} />
      <Card>
        <p className="text-sm text-ink-quiet">{arabic ? 'تاريخ الاستحقاق الأخير' : 'Final due date'}</p>
        <div className="mt-1 text-base text-ink">
          <DualDate gregorian={stored.maturityDateGregorian} hijri={stored.maturityDateHijri} locale={locale} />
        </div>
        <p className="mt-2 text-xs text-ink-quiet">
          <span className="identifier">{stored.productCode}</span> ·{' '}
          {arabic ? 'صالح لسبعة أيام' : 'valid for seven days'}
        </p>
      </Card>
      <Card>
        <form action={acceptAction} className="flex flex-col gap-4">
          <input type="hidden" name="locale" value={segment} />
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="disclosureVersion" value={stored.offer.disclosureVersion} />
          <label className="flex items-start gap-3 text-sm text-ink">
            <input type="checkbox" name="confirm" value="yes" className="mt-1 size-5 accent-brand" />
            <span>
              {arabic
                ? 'قرأت الإفصاح أعلاه وأفهم إجمالي المبلغ المستحق ومعدل النسبة السنوي.'
                : 'I have read the disclosure above and understand the total amount payable and the APR.'}
            </span>
          </label>
          <button
            type="submit"
            className="press inline-flex min-h-tap items-center justify-center rounded-pill bg-brand px-6 text-base font-semibold text-white hover:bg-brand-deep"
          >
            {arabic ? 'أقبل العرض' : 'Accept the offer'}
          </button>
          <a href={`/${segment}/apply`} className="text-center text-sm text-brand">
            {arabic ? 'تغيير المبلغ أو المدة' : 'Change the amount or term'}
          </a>
        </form>
      </Card>
    </div>
  );
}
