/**
 * The tenant's product catalogue, and what a customer would be shown.
 *
 * For each enabled product: the journey shape, the pricing rule the tenant
 * configured, the board ruling it is enabled under, and a worked quote
 * through the ProductModule interface with the platform's APR beside the
 * module's own disclosure. Nothing on this page is computed in the page: the
 * engine resolves the pricing inputs, the module quotes, the module
 * discloses, the platform computes APR, and the component renders.
 *
 * The benchmark used for benchmark-linked products is a development figure,
 * labelled as such. In production it comes through the Rate Publisher port and
 * a missing benchmark refuses the quote — which this page shows too, by
 * quoting once without it.
 */

import type { ReactElement } from 'react';

import { type TenantCode, isTenantCode } from '@sanad/config/loader.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { money } from '@sanad/core/kernel/money.ts';
import type { QuoteRequest } from '@sanad/core/products/module.ts';
import { buildOffer, type Offer } from '@sanad/core/products/offer.ts';
import { ProductRegistry } from '@sanad/core/products/registry.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { Disclosure } from '@sanad/design/Disclosure.tsx';
import { Card, PILL_OUTLINE, Status, Tile } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import { conventionalTerm } from '@sanad/products/conventional-term/index.ts';
import { embeddedLending } from '@sanad/products/embedded-lending/index.ts';
import { murabahaScf } from '@sanad/products/murabaha-scf/index.ts';
import { tawarruqPersonal } from '@sanad/products/tawarruq-personal/index.ts';

import { developmentAttestation } from '../../../server/store.ts';

const REGISTRY = new ProductRegistry().register(murabahaScf).register(tawarruqPersonal).register(bnpl).register(embeddedLending).register(conventionalTerm);
const SAMPLE_TRADE = { type: 'CLEARED_INVOICE' as const, invoiceUuid: '3cf5d9a2-0000-4000-8000-0000000000aa', invoiceHash: 'sample', issuerCr: '1010000002', recipientCr: '7001000001' };
/** Development stand-ins for the Rate Publisher. Labelled on the page. */
const DEV_BENCHMARK = { code: 'SAIBOR-3M', rate: rate(560n, 'REDUCING'), asOfEpochSeconds: 0n, referenceId: 'dev-benchmark' };
const DEV_RANGE = { productClass: 'PERSONAL', lowBp: 600n, medianBp: 900n, highBp: 1_500n, asOfEpochSeconds: 0n, referenceId: 'dev-range' };

/**
 * How the product reaches the core banking platform, in words for staff.
 * The mapping is configuration (Admin → Products & modules, under four eyes);
 * this page only reports it. Never shown to a customer.
 */
function coreBookingLabel(entry: { readonly coreBankingProductCode?: string }, bookingShape: 'CORE_FACILITY' | 'ACCOUNT_POSTINGS' | undefined, t: (en: string, ar: string) => string): { readonly code?: string; readonly text: string; readonly tone: 'settled' | 'progress' | 'blocked' } {
  if (bookingShape === 'ACCOUNT_POSTINGS') return { text: t('account postings · schedule and profit held in Sanad', 'قيود حسابات · الجدول والربح في سند'), tone: 'settled' };
  if (entry.coreBankingProductCode !== undefined) return { code: entry.coreBankingProductCode, text: t('core product type', 'نوع منتج في النظام المصرفي'), tone: 'settled' };
  return { text: t('not mapped yet', 'غير مرتبط بعد'), tone: 'progress' };
}

/** A sample request per journey shape. Amounts and facts are illustrative. */
function sampleFor(code: string, tenantId: string, at: QuoteRequest['asOf']): { readonly principal: bigint; readonly tenorDays: number; readonly build: (pricing: QuoteRequest['pricing']) => QuoteRequest; readonly note: { en: string; ar: string } } {
  const base = { tenantId, programmeId: 'prg-0001', counterpartyId: 'sample', asOf: at };
  switch (code) {
    case 'murabaha-scf':
      return { principal: 18_500_000n, tenorDays: 90, build: (pricing) => ({ ...base, requestedAmount: money(18_500_000n), requestedTenorDays: 90, tradeReference: SAMPLE_TRADE, pricing }), note: { en: 'A cleared invoice of SAR 185,000.00 over 90 days.', ar: 'فاتورة مُخلّصة بقيمة ١٨٥٬٠٠٠٫٠٠ ريال على ٩٠ يوماً.' } };
    case 'bnpl':
      return { principal: 120_000n, tenorDays: 120, build: (pricing) => ({ ...base, requestedAmount: money(120_000n), requestedTenorDays: 120, pricing, affordability: { outstandingSameClass: money(0n) } }), note: { en: 'A basket of SAR 1,200.00 in four instalments; the merchant pays the discount.', ar: 'سلة بقيمة ١٬٢٠٠٫٠٠ ريال على أربعة أقساط؛ الخصم على التاجر.' } };
    case 'embedded-lending':
      return { principal: 10_000_000n, tenorDays: 180, build: (pricing) => ({ ...base, requestedAmount: money(10_000_000n), requestedTenorDays: 180, pricing, partnerRef: 'aggregator-01', preferences: { collection: 'REVENUE_LINKED' } }), note: { en: 'A merchant advance of SAR 100,000.00 over 180 days, collected from partner-routed revenue.', ar: 'تمويل تاجر بقيمة ١٠٠٬٠٠٠٫٠٠ ريال على ١٨٠ يوماً، يُحصَّل من الإيرادات عبر الشريك.' } };
    default:
      return { principal: 5_000_000n, tenorDays: 360, build: (pricing) => ({ ...base, requestedAmount: money(5_000_000n), requestedTenorDays: 360, pricing, affordability: { monthlyIncome: money(2_000_000n), existingMonthlyObligations: money(0n) } }), note: { en: 'SAR 50,000.00 over 12 months for an applicant earning SAR 20,000.00 a month with no other obligations.', ar: '٥٠٬٠٠٠٫٠٠ ريال على ١٢ شهراً لمتقدّم دخله ٢٠٬٠٠٠٫٠٠ ريال شهرياً بلا التزامات أخرى.' } };
  }
}

export default async function ProductsPage({ params, searchParams }: { readonly params: Promise<{ readonly locale: string }>; readonly searchParams: Promise<{ readonly tenant?: string }> }): Promise<ReactElement> {
  const { locale: segment } = await params;
  const { tenant: tenantParam } = await searchParams;
  const locale = localeFromSegment(segment) ?? 'en-SA';
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const tenant: TenantCode = tenantParam !== undefined && isTenantCode(tenantParam) ? tenantParam : 'bank-a';
  const at = developmentAttestation();
  const resolved = await resolveProductCatalogue(tenant, at.epochSeconds);
  const catalogue = resolved.catalogue;

  const entries = catalogue.ok ? catalogue.value.entries : [];
  const enabled = entries.filter((e) => e.enabled);
  const islamic = enabled.filter((e) => e.boardRulingRef !== undefined);
  const consumer = enabled.filter((e) => { const m = REGISTRY.find(e.productCode); return m.ok && m.value.descriptor.consumer; });
  const programmes = new Set(enabled.flatMap((e) => (e.programmeIds === 'ALL' ? ['ALL'] : [...e.programmeIds])));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-h2 font-semibold text-heading">{t('Products — ', 'المنتجات — ')}<span className="identifier">{tenant}</span></h2>
        <nav className="flex gap-2 text-sm">
          {(['bank-a', 'fintech-b'] as const).map((code) => (
            <a key={code} href={`/${segment}/products?tenant=${code}`} className={`identifier press rounded-pill px-4 py-2 ${code === tenant ? 'bg-brand-deep text-white' : 'bg-surface text-ink-quiet hover:bg-sunken'}`}>{code}</a>
          ))}
        </nav>
      </div>

      {/* -- The Loans frame's four tiles ------------------------------------------ */}
      <section className="grid gap-[30px] sm:grid-cols-2 2xl:grid-cols-4">
        <Tile icon="store" disc="blue" label={t('Products enabled', 'منتجات مفعّلة')} value={String(enabled.length)} />
        <Tile icon="shield-check" disc="yellow" label={t('Under a board ruling', 'بقرار من الهيئة')} value={String(islamic.length)} />
        <Tile icon="people" disc="pink" label={t('Consumer products', 'منتجات للأفراد')} value={String(consumer.length)} />
        <Tile icon="building" disc="teal" label={t('Programmes', 'البرامج')} value={programmes.has('ALL') ? t('All', 'الكل') : String(programmes.size)} />
      </section>

      {/* -- The catalogue as the Loans table ------------------------------------- */}
      <div>
        <h3 className="mb-4 text-h2 font-semibold text-heading">{t('Catalogue', 'الكتالوج')}</h3>
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[16px]">
              <thead>
                <tr className="border-b border-line text-[16px] text-ink-quiet">
                  <th className="py-3 pe-3 text-start font-normal">{t('No.', 'م')}</th>
                  <th className="py-3 pe-3 text-start font-normal">{t('Product', 'المنتج')}</th>
                  <th className="py-3 pe-3 text-start font-normal">{t('Pricing rule', 'قاعدة التسعير')}</th>
                  <th className="py-3 pe-3 text-start font-normal">{t('Programmes', 'البرامج')}</th>
                  <th className="py-3 pe-3 text-start font-normal">{t('Board ruling', 'قرار الهيئة')}</th>
                  <th className="py-3 pe-3 text-start font-normal">{t('Journey', 'المسار')}</th>
                  <th className="py-3 pe-3 text-start font-normal">{t('Books in core banking as', 'يُحجز في النظام المصرفي كـ')}</th>
                  <th className="py-3 text-end font-normal">{t('Disclosure', 'الإفصاح')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const found = REGISTRY.find(entry.productCode);
                  const module = found.ok ? found.value : undefined;
                  return (
                    <tr key={entry.productCode} className="border-b border-line last:border-b-0">
                      <td className="py-4 pe-3 tabular-nums text-ink">{String(i + 1).padStart(2, '0')}.</td>
                      <td className="py-4 pe-3"><span className="flex flex-col"><span className="font-medium text-ink">{arabic ? entry.nameAr : entry.nameEn}</span><span className="identifier text-xs text-ink-quiet">{entry.productCode}</span></span></td>
                      <td className="py-4 pe-3 text-ink"><span className="identifier">{entry.pricingRule.kind}</span>{entry.pricingRule.kind === 'CATALOGUE_RATE' ? <span className="block text-xs text-ink-quiet">{entry.pricingRule.bp} bp {entry.pricingRule.basis}</span> : entry.pricingRule.kind === 'BENCHMARK_PLUS_MARGIN' ? <span className="block text-xs text-ink-quiet">{entry.pricingRule.benchmarkCode} + {entry.pricingRule.marginBp} bp</span> : null}</td>
                      <td className="py-4 pe-3 text-ink"><span className="identifier">{entry.programmeIds === 'ALL' ? 'ALL' : entry.programmeIds.join(', ')}</span></td>
                      <td className="py-4 pe-3 text-ink"><span className="identifier">{entry.boardRulingRef ?? '—'}</span></td>
                      <td className="py-4 pe-3 text-ink-quiet">{module === undefined ? '—' : `${module.descriptor.journeyShape === 'TRADE_FIRST' ? t('trade first', 'يبدأ من الصفقة') : t('amount first', 'يبدأ من المبلغ')}${module.descriptor.consumer ? ` · ${t('consumer', 'أفراد')}` : ''}`}</td>
                      <td className="py-4 pe-3">{(() => { const c = coreBookingLabel(entry, module?.descriptor.bookingShape, t); return <span className="flex flex-col gap-1">{c.code === undefined ? null : <span className="identifier text-ink">{c.code}</span>}<Status tone={c.tone} label={c.text} /></span>; })()}</td>
                      <td className="py-4 text-end">{!entry.enabled ? <Status tone="blocked" label={t('disabled', 'معطّل')} /> : module === undefined ? <Status tone="progress" label={t('module not built', 'الوحدة غير مبنية')} /> : <a href={`#disclosure-${entry.productCode}`} className={PILL_OUTLINE}>{t('Preview', 'عرض')}</a>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <h3 className="text-h2 font-semibold text-heading">{t('Worked disclosures', 'إفصاحات عملية')}</h3>
      <p className="-mt-6 text-sm text-ink-quiet">{t('Every figure below came out of the engine; the page only renders it. Benchmark-linked products use a development benchmark here, labelled as such.', 'كل رقم أدناه خرج من المحرّك؛ الصفحة تعرضه فقط. المنتجات المرتبطة بمؤشر تستخدم هنا مؤشراً تطويرياً، مُبيَّناً كذلك.')}</p>
      {!catalogue.ok ? <Card><p className="text-sm text-blocked">{catalogue.error.detail}</p></Card> : catalogue.value.entries.filter((e) => e.enabled).map((entry) => {
        const found = REGISTRY.find(entry.productCode);
        const module = found.ok ? found.value : undefined;
        let offer: Offer | undefined;
        let refusal: string | undefined;
        if (module !== undefined && entry.enabled) {
          const sample = sampleFor(entry.productCode, tenant, at);
          const terms = module.validateTerms(entry.terms);
          const inputs = resolvePricingInputs(entry.pricingRule, { principal: money(sample.principal), tenorDays: sample.tenorDays, asOfEpochSeconds: at.epochSeconds, benchmark: DEV_BENCHMARK, marketRange: DEV_RANGE });
          if (!terms.ok) refusal = terms.error.detail;
          else if (!inputs.ok) refusal = inputs.error.detail;
          else {
            const quote = module.quote(terms.value, sample.build(inputs.value));
            if (!quote.ok) refusal = `${quote.error.reason}: ${quote.error.detail}`;
            else { const built = buildOffer(module, quote.value, at); if (built.ok) offer = built.value; else refusal = built.error.detail; }
          }
        }
        const sample = sampleFor(entry.productCode, tenant, at);
        return (
          <Card key={entry.productCode}>
            <div id={`disclosure-${entry.productCode}`} className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">{arabic ? entry.nameAr : entry.nameEn} <span className="identifier text-xs text-ink-quiet">{entry.productCode}</span></h2>
              <Status tone={!entry.enabled ? 'blocked' : module !== undefined ? 'settled' : 'progress'} label={!entry.enabled ? t('disabled', 'معطّل') : module !== undefined ? t('module built', 'الوحدة مبنية') : t('enabled · module not built', 'مفعّل · الوحدة غير مبنية')} />
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
              <dt className="text-ink-quiet">{t('Pricing rule', 'قاعدة التسعير')}</dt><dd className="identifier">{entry.pricingRule.kind}{entry.pricingRule.kind === 'CATALOGUE_RATE' ? ` · ${entry.pricingRule.bp} bp ${entry.pricingRule.basis}` : entry.pricingRule.kind === 'BENCHMARK_PLUS_MARGIN' ? ` · ${entry.pricingRule.benchmarkCode} + ${entry.pricingRule.marginBp} bp` : ` · ${entry.pricingRule.profitMinorUnits}`}</dd>
              <dt className="text-ink-quiet">{t('Programmes', 'البرامج')}</dt><dd className="identifier">{entry.programmeIds === 'ALL' ? 'ALL' : entry.programmeIds.join(', ')}</dd>
              <dt className="text-ink-quiet">{t('Board ruling', 'قرار الهيئة')}</dt><dd className="identifier">{entry.boardRulingRef ?? t('— (not an Islamic product)', '— (ليس منتجاً إسلامياً)')}</dd>
              <dt className="text-ink-quiet">{t('Journey · family', 'المسار · النوع')}</dt><dd className="identifier">{module === undefined ? '—' : `${module.descriptor.journeyShape} · ${module.descriptor.family}${module.descriptor.consumer ? ' · consumer' : ''}`}</dd>
              <dt className="text-ink-quiet">{t('Core banking', 'النظام المصرفي')}</dt><dd>{(() => { const c = coreBookingLabel(entry, module?.descriptor.bookingShape, t); return c.code === undefined ? <span className="text-ink-quiet">{c.text}</span> : <span><span className="identifier">{c.code}</span> <span className="text-ink-quiet">· {c.text}</span></span>; })()}</dd>
            </dl>
            {offer !== undefined ? (
              <div className="mt-4">
                <p className="mb-2 text-xs text-ink-quiet">{t('Worked example: ', 'مثال عملي: ')}{arabic ? sample.note.ar : sample.note.en}{entry.pricingRule.kind === 'BENCHMARK_PLUS_MARGIN' ? t(' Development benchmark 5.60%, bounded by a development market range.', ' مؤشر تطويري ٥٫٦٠٪ محدود بنطاق سوق تطويري.') : ''}</p>
                <Disclosure offer={offer} locale={locale} />
              </div>
            ) : refusal !== undefined ? <p className="mt-3 text-sm text-attention"><span className="identifier">{t('refused', 'مرفوض')}</span> · {refusal}</p> : null}
          </Card>
        );
      })}
    </div>
  );
}
