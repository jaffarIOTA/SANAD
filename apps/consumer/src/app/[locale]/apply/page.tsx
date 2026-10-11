/**
 * Amount-first application (ADR 0002). The product module declares the
 * journey shape; every consumer product is amount-first, so the journey
 * opens with the amount and the term. The quote, the schedule, the APR and
 * the disclosure all come from the engine on the next screen.
 *
 * Layout follows the lending journeys of the reference apps (one question as
 * the title, the amount as the screen's single large figure, one primary
 * action that names what happens next). Nothing here states a limit or a
 * price: those belong to the product module and arrive with the offer.
 */

import type { ReactNode } from 'react';
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

/** The line under a product's name: its basis, and the board ruling where it is Islamic. */
function productBasis(family: string, boardRulingRef: string | undefined, arabic: boolean): ReactNode {
  if (family !== 'ISLAMIC') return arabic ? 'تمويل تقليدي' : 'Conventional finance';
  return (
    <>
      {arabic ? 'متوافق مع الشريعة · قرار الهيئة ' : 'Shariah-compliant · board ruling '}
      <bdi className="identifier whitespace-nowrap">{boardRulingRef ?? ''}</bdi>
    </>
  );
}

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
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-brand-strong">{arabic ? 'الخطوة ١ من ٢' : 'Step 1 of 2'}</p>
        <h1 className="text-h1 font-semibold text-heading">{arabic ? 'كم تحتاج؟' : 'How much do you need?'}</h1>
        <p className="text-lede text-ink-quiet">
          {arabic
            ? 'اختر المبلغ والمدة والمنتج. سترى كل التكاليف، ومنها معدل النسبة السنوي، قبل أن توافق على أي شيء.'
            : 'Choose an amount, a term and a product. You will see every cost, including the APR, before you agree to anything.'}
        </p>
      </header>
      {refused !== undefined ? (
        <ControlRejection
          control={control ?? 'OP-DETERMINACY'}
          explanation={explain(refused, arabic)}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}
      <Card>
        <form action={quoteAction} className="flex flex-col gap-8">
          <input type="hidden" name="locale" value={segment} />

          <div className="flex flex-col gap-2">
            <label htmlFor="amount" className="text-sm font-medium text-ink">
              {arabic ? 'المبلغ' : 'Amount'}
            </label>
            <div className="flex items-baseline gap-3 rounded-tile bg-field px-5 py-4 focus-within:ring-2 focus-within:ring-brand/40">
              <input
                id="amount"
                name="amount"
                inputMode="numeric"
                autoComplete="off"
                defaultValue="50000"
                required
                aria-describedby="amount-hint"
                className="identifier min-w-0 flex-1 bg-transparent text-display font-semibold text-ink focus-visible:outline-none"
              />
              <span className="text-lg font-medium text-ink-quiet">{arabic ? 'ر.س' : 'SAR'}</span>
            </div>
            <p id="amount-hint" className="text-sm text-ink-quiet">
              {arabic
                ? 'بالريال، دون هللات. يمكنك تغييره بعد أن ترى العرض.'
                : 'In whole riyals. You can change it after you see the offer.'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="months" className="text-sm font-medium text-ink">
              {arabic ? 'مدة السداد' : 'Repayment term'}
            </label>
            <div className="flex h-14 items-center gap-3 rounded-tile bg-field px-5 focus-within:ring-2 focus-within:ring-brand/40">
              <input
                id="months"
                name="months"
                inputMode="numeric"
                autoComplete="off"
                defaultValue="12"
                required
                className="identifier min-w-0 flex-1 bg-transparent text-lg font-medium text-ink focus-visible:outline-none"
              />
              <span className="text-base text-ink-quiet">{arabic ? 'شهراً' : 'months'}</span>
            </div>
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-sm font-medium text-ink">{arabic ? 'المنتج' : 'Product'}</legend>
            {products.map(({ entry, module }, i) => (
              <label
                key={entry.productCode}
                className="flex min-h-tap cursor-pointer items-start gap-4 rounded-tile border border-line p-4 transition-colors has-[:checked]:border-brand has-[:checked]:bg-brand-wash"
              >
                <input
                  type="radio"
                  name="productCode"
                  value={entry.productCode}
                  defaultChecked={i === 0}
                  className="mt-1 size-5 shrink-0 accent-brand"
                />
                <span className="flex flex-col gap-1">
                  <span className="text-base font-semibold text-ink">{arabic ? entry.nameAr : entry.nameEn}</span>
                  <span className="text-sm text-ink-quiet">
                    {productBasis(module.descriptor.family, entry.boardRulingRef, arabic)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-3">
            <button
              type="submit"
              className="press inline-flex h-14 w-full items-center justify-center rounded-pill bg-brand px-6 text-base font-semibold text-white hover:bg-brand-deep"
            >
              {arabic ? 'اعرض عرضي' : 'See my offer'}
            </button>
            <p className="text-center text-sm text-ink-quiet">
              {arabic
                ? 'لا يُعتمد شيء حتى تقبل في الخطوة التالية.'
                : 'Nothing is agreed until you accept on the next screen.'}
            </p>
          </div>
        </form>
      </Card>
      <aside className="rounded-tile border border-line bg-sunken p-4 text-sm text-ink-quiet">
        <p className="mb-1 font-medium text-ink">{arabic ? 'بيئة تطوير' : 'Development environment'}</p>
        <p>
          {arabic ? 'حقائق القدرة على السداد بديلة: دخل شهري ' : 'Affordability facts are a stand-in: monthly income '}
          <bdi className="tabular-nums">{formatMinorUnits(DEV_AFFORDABILITY.monthlyIncome, numerals)}</bdi> SAR
          {arabic
            ? '، بلا التزامات قائمة. في الإنتاج تأتي من التأمينات الاجتماعية والمكتب الائتماني بموافقتك.'
            : ', no existing obligations. In production these come from employment verification and the bureau, with your consent.'}
        </p>
      </aside>
    </div>
  );
}
