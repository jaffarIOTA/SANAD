/**
 * Amount-first application (ADR 0002). The product module declares the
 * journey shape; every consumer product is amount-first, so the journey
 * opens with the amount and the term. The quote, the schedule, the APR and
 * the disclosure all come from the engine on the next screen.
 */

import { notFound, redirect } from 'next/navigation';

import { Card, ControlRejection } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { quoteAction } from '../../../server/actions.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';

import { DEV_AFFORDABILITY, TENANT, consumerProducts } from '../../../server/engine.ts';
import { developmentAttestation } from '../../../server/store.ts';
import { explain } from '../../../server/explain.ts';
import { currentSession } from '../../../server/session.ts';
import { formatMinorUnits, defaultNumerals } from '@sanad/design/Money.tsx';

export default async function ApplyPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly refused?: string; readonly control?: string }>;
}) {
  const { locale: segment } = await params;
  const { refused, control } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const session = await currentSession();
  if (session === undefined) redirect(`/${segment}`);
  const products = consumerProducts(
    (await resolveProductCatalogue(TENANT, developmentAttestation().epochSeconds)).catalogue,
  );
  const numerals = defaultNumerals(locale);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-h1 font-semibold text-heading">{arabic ? 'كم تحتاج؟' : 'How much do you need?'}</h1>
        <p className="mt-2 text-[15px] text-ink-quiet">
          {arabic
            ? 'اختر المنتج والمبلغ والمدة. سترى الإفصاح الكامل — الأقساط والتكلفة ومعدل النسبة السنوي — قبل أن تقبل شيئاً.'
            : 'Choose the product, the amount and the term. You will see the full disclosure — instalments, cost and APR — before you accept anything.'}
        </p>
      </div>
      {refused !== undefined ? (
        <ControlRejection
          control={control ?? 'OP-DETERMINACY'}
          explanation={explain(refused, arabic)}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}
      <Card>
        <form action={quoteAction} className="flex flex-col gap-4">
          <input type="hidden" name="locale" value={segment} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-ink">{arabic ? 'المنتج' : 'Product'}</legend>
            {products.map(({ entry, module }, i) => (
              <label
                key={entry.productCode}
                className="flex cursor-pointer items-start gap-3 rounded-tile border border-line p-3 has-[:checked]:border-brand has-[:checked]:bg-brand-wash"
              >
                <input
                  type="radio"
                  name="productCode"
                  value={entry.productCode}
                  defaultChecked={i === 0}
                  className="mt-1 accent-brand"
                />
                <span className="flex flex-col">
                  <span className="text-[15px] font-medium text-ink">{arabic ? entry.nameAr : entry.nameEn}</span>
                  <span className="text-xs text-ink-quiet">
                    {module.descriptor.family === 'ISLAMIC'
                      ? arabic
                        ? `متوافق مع الشريعة · قرار الهيئة ${entry.boardRulingRef ?? ''}`
                        : `Shariah-compliant · board ruling ${entry.boardRulingRef ?? ''}`
                      : arabic
                        ? 'تمويل تقليدي'
                        : 'Conventional finance'}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            {arabic ? 'المبلغ (ريال)' : 'Amount (SAR)'}
            <input
              name="amount"
              inputMode="numeric"
              defaultValue="50000"
              required
              className="identifier h-[50px] rounded-pill bg-field ps-5 pe-4 text-base outline-none focus:ring-2 focus:ring-brand/40"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-ink">
            {arabic ? 'المدة (أشهر)' : 'Term (months)'}
            <input
              name="months"
              inputMode="numeric"
              defaultValue="12"
              required
              className="identifier h-[50px] rounded-pill bg-field ps-5 pe-4 text-base outline-none focus:ring-2 focus:ring-brand/40"
            />
          </label>
          <button
            type="submit"
            className="press inline-flex min-h-tap items-center justify-center rounded-pill bg-brand px-6 text-base font-semibold text-white hover:bg-brand-deep"
          >
            {arabic ? 'اعرض لي الإفصاح' : 'Show me the disclosure'}
          </button>
        </form>
      </Card>
      <p className="text-xs text-ink-quiet">
        {arabic
          ? 'حقائق القدرة على السداد (بيئة تطوير): دخل شهري '
          : 'Affordability facts (development stand-in): monthly income '}
        <bdi className="tabular-nums">{formatMinorUnits(DEV_AFFORDABILITY.monthlyIncome, numerals)}</bdi> SAR
        {arabic
          ? '، بلا التزامات قائمة. في الإنتاج تأتي من التأمينات الاجتماعية والمكتب الائتماني بموافقتك.'
          : ', no existing obligations. In production these come from employment verification and the bureau, under your consent.'}
      </p>
    </div>
  );
}
