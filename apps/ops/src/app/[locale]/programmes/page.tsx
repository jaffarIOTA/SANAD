/**
 * Programmes and anchors (Wasl W5b), as the workbench reads them: each
 * programme in force with its limit, what it holds, what is left, its
 * facilities and its transactions; and each anchor with the programmes it
 * anchors, what they hold and their share of the book. Read-only: programmes
 * and anchors are changed in Admin → Programmes, by one administrator and
 * approved by another.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { maskIban } from '@sanad/core/kernel/iban.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { hydrate } from '@sanad/origination/wasl/book.ts';
import { resolveProgrammes, resolveWaslParties } from '@sanad/origination/wasl/configuration.ts';
import { HOLDING, exposureOf } from '@sanad/origination/wasl/exposure.ts';
import { facilitiesFrom, facilityApprovals } from '@sanad/origination/wasl/facilities.ts';

import { pageStaff } from '../../../server/session.ts';

export default async function ProgrammesPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;
  const parties = await resolveWaslParties(tenant);
  const source = await resolveProgrammes(tenant);
  const amount = (minorUnits: bigint) => (
    <bdi className="tabular-nums">{formatMinorUnits({ minorUnits, currency: 'SAR' }, numerals)} SAR</bdi>
  );
  // Per ten thousand of the book, shown as a percentage in whole numbers.
  const share = (part: bigint, whole: bigint) => {
    const n = whole === 0n ? 0n : (part * 10_000n) / whole;
    return `${String(n / 100n)}.${String(n % 100n).padStart(2, '0')}%`;
  };

  if (!parties.ok)
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-display font-bold tracking-tight text-heading">{t('Programmes', 'البرامج')}</h1>
        <p className="text-[14px] text-ink-quiet">
          {t('No Wasl programme is configured for this institution.', 'لا يوجد برنامج وصل مُعدّ لهذه المؤسسة.')}
        </p>
      </div>
    );

  const book = [...(await hydrate(tenant)).records.values()];
  const facilities = facilitiesFrom(await facilityApprovals(tenant));
  const programmes = parties.value.programmes;
  const bookLimit = programmes.reduce((s, p) => s + p.programmeLimitMinorUnits, 0n);
  const anchors = [...new Map(programmes.map((p) => [p.anchor.registrationNo, p.anchor])).values()];

  return (
    <div className="flex flex-col gap-6" data-programmes>
      <div>
        <h1 className="text-display font-bold tracking-tight text-heading">{t('Programmes', 'البرامج')}</h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            'Each programme finances one anchor’s cleared invoices to the distributors that buy from it. Programmes, their limits and their anchors are changed in Admin → Programmes, by one administrator and approved by another.',
            'يموّل كل برنامج الفواتير المعتمدة لجهة راعية واحدة للموزعين الذين يشترون منها. تُغيّر البرامج وحدودها وجهاتها الراعية في الإدارة ← البرامج، ويقترحها مسؤول ويعتمدها آخر.',
          )}
        </p>
        <p className="mt-1 text-[12px] text-ink-quiet">
          {source.source === 'REVISION'
            ? `${t('Approved revision', 'مراجعة معتمدة')}: ${source.revisionSummary ?? ''}`
            : t('From the checked-in configuration', 'من الإعداد المضمّن')}
        </p>
      </div>

      {programmes.map((p) => {
        const held = exposureOf(book, parties.value, '', p.programmeId).programmeHeld;
        const own = facilities.filter((f) => f.programmeId === p.programmeId);
        const txns = book.filter((r) => r.transaction.core.programmeId === p.programmeId);
        const live = txns.filter((r) => HOLDING.has(r.transaction.state)).length;
        return (
          <section
            key={p.programmeId}
            className="rounded-card border border-line bg-surface px-5 py-4 shadow-card"
            data-programme={p.programmeId}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-heading">{t(p.nameEn, p.nameAr)}</h2>
              <span className="identifier text-[12px] text-ink-quiet">{p.programmeId}</span>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
              <div>
                <dt className="text-ink-quiet">{t('Limit', 'الحد')}</dt>
                <dd className="font-medium text-heading">{amount(p.programmeLimitMinorUnits)}</dd>
              </div>
              <div>
                <dt className="text-ink-quiet">{t('Held', 'المحجوز')}</dt>
                <dd className="font-medium text-heading">{amount(held)}</dd>
              </div>
              <div>
                <dt className="text-ink-quiet">{t('Available', 'المتاح')}</dt>
                <dd className="font-medium text-heading">
                  {amount(p.programmeLimitMinorUnits > held ? p.programmeLimitMinorUnits - held : 0n)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-quiet">{t('Transactions', 'المعاملات')}</dt>
                <dd className="font-medium text-heading">
                  {t(
                    `${String(live)} live of ${String(txns.length)}`,
                    `${String(live)} قائمة من ${String(txns.length)}`,
                  )}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[13px] text-ink-quiet">
              {t('Anchor', 'الجهة الراعية')}: <span className="text-ink">{t(p.anchor.nameEn, p.anchor.nameAr)}</span>{' '}
              <span className="identifier">{p.anchor.registrationNo}</span> ·{' '}
              <bdi dir="ltr" className="identifier">
                {maskIban(p.anchor.settlementIban)}
              </bdi>
            </p>
            <p className="mt-1 text-[13px] text-ink-quiet">
              {t('Facilities', 'التسهيلات')}: {String(own.length)} ·{' '}
              {amount(own.reduce((s, f) => s + f.limit.minorUnits, 0n))} ·{' '}
              <a href={`/${segment}/facilities`} className="text-brand hover:underline">
                {t('Facilities', 'التسهيلات')}
              </a>
            </p>
          </section>
        );
      })}

      <section
        id="anchors"
        className="overflow-x-auto rounded-card border border-line bg-surface shadow-card"
        data-anchors
      >
        <h2 className="px-5 pt-4 text-[15px] font-semibold text-heading">{t('Anchors', 'الجهات الراعية')}</h2>
        <table className="mt-2 w-full text-[13px]">
          <thead>
            <tr className="text-ink-quiet">
              <th className="px-5 py-2 text-start font-normal">{t('Anchor', 'الجهة الراعية')}</th>
              <th className="px-3 py-2 text-start font-normal">{t('Programmes', 'البرامج')}</th>
              <th className="px-3 py-2 text-end font-normal">{t('Held', 'المحجوز')}</th>
              <th className="px-5 py-2 text-end font-normal">{t('Share of the book', 'النصيب من المحفظة')}</th>
            </tr>
          </thead>
          <tbody>
            {anchors.map((a) => {
              const theirs = programmes.filter((p) => p.anchor.registrationNo === a.registrationNo);
              const held = exposureOf(book, parties.value, '', theirs[0]?.programmeId ?? '').anchorHeld;
              const limits = theirs.reduce((s, p) => s + p.programmeLimitMinorUnits, 0n);
              return (
                <tr key={a.registrationNo} className="border-t border-line">
                  <td className="px-5 py-2">
                    <span className="block">{t(a.nameEn, a.nameAr)}</span>
                    <span className="identifier text-ink-quiet">{a.registrationNo}</span>
                  </td>
                  <td className="px-3 py-2">{theirs.map((p) => p.programmeId).join(', ')}</td>
                  <td className="px-3 py-2 text-end">{amount(held)}</td>
                  <td className="px-5 py-2 text-end">
                    <span title={t('Of the sum of programme limits', 'من مجموع حدود البرامج')}>
                      {share(limits, bookLimit)}
                    </span>
                    <span className="block text-[12px] text-ink-quiet">
                      {t('held', 'المحجوز')} {share(held, bookLimit)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="px-5 pb-4 pt-2 text-[12px] text-ink-quiet">
          {t(
            'The book is the sum of the institution’s programme limits; an anchor’s share is measured against it, as the concentration rule measures it.',
            'المحفظة هي مجموع حدود برامج المؤسسة، ويُقاس نصيب الجهة الراعية منها كما تقيسه قاعدة التركّز.',
          )}
        </p>
      </section>
    </div>
  );
}
