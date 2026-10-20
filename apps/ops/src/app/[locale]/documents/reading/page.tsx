/**
 * Document reading: the throughput view (document intelligence D5). How the
 * reading and the checks are doing against what the checkers decided, for the
 * signed-in person's institution's business applications.
 *
 * Measurement only. It accepts and refuses nothing, and no figure here feeds
 * a decision: every document is still checked by a second person (product
 * owner, 19 October 2026). It is the evidence for revisiting that, if ever.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { DocumentMetrics } from '@sanad/core/documents/metrics.ts';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { syncBusiness } from '../../../../server/business.ts';
import { businessDocumentMetrics } from '../../../../server/document-metrics.ts';
import { staffJurisdiction } from '../../../../server/jurisdiction.ts';
import { pageStaff } from '../../../../server/session.ts';
import { type Formatters, MetricTile, SectionCard, formatters } from '../../business/ui.tsx';

const CHECK_NAME: Readonly<Record<string, readonly [string, string]>> = {
  TYPE_MATCHES_DECLARED: ['Is the document presented', 'هو المستند المقدَّم'],
  NOT_EXPIRED: ['Not expired', 'غير منتهي'],
  ISSUED_WITHIN: ['Issued recently enough', 'صادر حديثًا بما يكفي'],
  PERIOD_ENDS_WITHIN: ['Statement ends recently', 'الكشف حديث'],
  PERIOD_COVERS: ['Statement covers the period', 'الكشف يغطي الفترة'],
  REGISTRATION_MATCHES: ['Registration number matches', 'رقم السجل مطابق'],
  NAME_FOUND: ['Business name found', 'اسم المنشأة موجود'],
  AUTHENTIC: ['Confirmed by the issuer', 'مؤكد من الجهة المصدرة'],
};

/** Whole per cent, for display: integer arithmetic, truncated. */
const pct = (part: number, whole: number): number | undefined =>
  whole === 0 ? undefined : Math.floor((part * 100) / whole);

function duration(seconds: bigint | undefined, f: Formatters): string {
  if (seconds === undefined) return '—';
  const hours = seconds / 3600n;
  if (hours < 1n) return f.t(`${f.n(seconds / 60n)} min`, `${f.n(seconds / 60n)} دقيقة`);
  if (hours < 48n) return f.t(`${f.n(hours)} h`, `${f.n(hours)} ساعة`);
  return f.t(`${f.n(hours / 24n)} days`, `${f.n(hours / 24n)} يومًا`);
}

export default async function DocumentReadingPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  // The signed-in person's own institution; nothing in the request names it.
  const staff = await pageStaff(segment);
  const j = await staffJurisdiction(staff.tenantId);
  const f = formatters(locale === 'ar-SA', j.currency);
  const { t } = f;
  if (j.tenant === undefined)
    return (
      <p className="rounded-card border border-line bg-surface p-6 text-ink-quiet">
        {t('No institution is onboarded under this jurisdiction yet.', 'لا توجد مؤسسة مسجلة في هذه الولاية بعد.')}
      </p>
    );
  await syncBusiness(j.tenant);
  const m = await businessDocumentMetrics(j.tenant);

  return (
    <div className="flex flex-col gap-6" data-document-metrics>
      <div>
        <h1 className="text-h2 font-semibold text-heading">{t('Document reading', 'قراءة المستندات')}</h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            'How the reading and the checks compare with what the checkers decided, across business applications. Measurement only: every document is still checked by a second person.',
            'مدى توافق القراءة والفحوص مع قرارات المراجعين في طلبات المنشآت. للقياس فقط: يظل كل مستند يُراجع من شخص ثانٍ.',
          )}
        </p>
      </div>
      <Overview m={m} f={f} />
      <Checker m={m} f={f} />
      <ChecksTable m={m} f={f} />
    </div>
  );
}

function Overview({ m, f }: { readonly m: DocumentMetrics; readonly f: Formatters }): ReactElement {
  const { t } = f;
  const fa = m.firstAttempt;
  const named = fa.namedRight + fa.namedWrong;
  const right = pct(fa.namedRight, named);
  return (
    <SectionCard title={t('Throughput', 'الإنتاجية')}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label={t('Documents read', 'المستندات المقروءة')}
          value={f.n(m.read)}
          sub={t(`of ${f.n(m.documents)} presented`, `من ${f.n(m.documents)} مقدَّمة`)}
        />
        <MetricTile
          label={t('Named right first time', 'تسمية صحيحة من أول مرة')}
          value={right === undefined ? '—' : `${f.n(right)}%`}
          sub={t(
            `${f.n(fa.namedRight)} of ${f.n(named)} accepted documents; ${f.n(fa.notNamed)} not recognised`,
            `${f.n(fa.namedRight)} من ${f.n(named)} مستندات مقبولة؛ ${f.n(fa.notNamed)} لم يُتعرّف عليها`,
          )}
        />
        <MetricTile
          label={t('Touchpoints per application', 'نقاط التواصل لكل طلب')}
          value={f.n(m.touchpoints.median)}
          sub={t(
            `median of ${f.n(m.touchpoints.applications)}; most ${f.n(m.touchpoints.max)}`,
            `الوسيط من ${f.n(m.touchpoints.applications)}؛ الأعلى ${f.n(m.touchpoints.max)}`,
          )}
        />
        <MetricTile
          label={t('First document to complete pack', 'من أول مستند إلى اكتمال الملف')}
          value={duration(m.timeToComplete.medianSeconds, f)}
          sub={t(
            `median of ${f.n(m.timeToComplete.complete)} complete; 90% within ${duration(m.timeToComplete.p90Seconds, f)}`,
            `الوسيط من ${f.n(m.timeToComplete.complete)} مكتملة؛ ٩٠٪ خلال ${duration(m.timeToComplete.p90Seconds, f)}`,
          )}
        />
      </div>
    </SectionCard>
  );
}

function Checker({ m, f }: { readonly m: DocumentMetrics; readonly f: Formatters }): ReactElement {
  const { t } = f;
  const c = m.checker;
  const agreed = pct(c.agreed, c.decided);
  const overrides = Object.entries(c.acceptedDespiteFailureByCheck).sort((a, b) => b[1] - a[1]);
  return (
    <SectionCard
      title={t('The checker and the findings', 'المراجِع والنتائج')}
      note={t(
        'Decided documents with at least one check that could be made.',
        'المستندات التي بُتّ فيها وفيها فحص واحد على الأقل أمكن إجراؤه.',
      )}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricTile
          label={t('Agreed with the findings', 'وافق النتائج')}
          value={agreed === undefined ? '—' : `${f.n(agreed)}%`}
          sub={t(`${f.n(c.agreed)} of ${f.n(c.decided)}`, `${f.n(c.agreed)} من ${f.n(c.decided)}`)}
        />
        <MetricTile
          label={t('Accepted despite a failed check', 'قُبل رغم فشل فحص')}
          value={f.n(c.acceptedDespiteFailure)}
          tone={c.acceptedDespiteFailure > 0 ? 'warn' : 'quiet'}
          sub={t('the checker overrode a finding', 'تجاوز المراجِع نتيجة')}
        />
        <MetricTile
          label={t('Refused with nothing failing', 'رُفض دون فشل أي فحص')}
          value={f.n(c.refusedWithNothingFailing)}
          sub={t('the checker saw what the checks did not', 'رأى المراجِع ما لم تره الفحوص')}
        />
      </div>
      {overrides.length === 0 ? null : (
        <ul className="mt-4 flex flex-col gap-1 text-[13px] text-ink" data-overrides>
          {overrides.map(([check, n]) => (
            <li key={check}>
              {t(
                `${checkName(check, f)}: accepted ${f.n(n)} times despite failing`,
                `${checkName(check, f)}: قُبل ${f.n(n)} مرات رغم الفشل`,
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

const checkName = (check: string, f: Formatters): string => {
  const k = CHECK_NAME[check];
  return k === undefined ? check : f.t(k[0], k[1]);
};

function ChecksTable({ m, f }: { readonly m: DocumentMetrics; readonly f: Formatters }): ReactElement {
  const { t } = f;
  // In the order a checker reads a document: what it is first, then its dates, then whose it is, then the issuer.
  const order = Object.keys(CHECK_NAME);
  const rank = (check: string) => (order.includes(check) ? order.indexOf(check) : order.length);
  const rows = Object.entries(m.checks).sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  return (
    <SectionCard
      title={t('Checks by type', 'الفحوص حسب النوع')}
      note={t('Over the latest reading of every document.', 'على آخر قراءة لكل مستند.')}
    >
      {rows.length === 0 ? (
        <p className="text-[13px] text-ink-quiet">{t('No document has been read yet.', 'لم يُقرأ أي مستند بعد.')}</p>
      ) : (
        <table className="w-full text-[13px]" data-checks-table>
          <thead>
            <tr className="text-start text-ink-quiet">
              <th className="py-2 pe-3 text-start font-medium">{t('Check', 'الفحص')}</th>
              <th className="py-2 pe-3 text-end font-medium">{t('Passed', 'نجح')}</th>
              <th className="py-2 pe-3 text-end font-medium">{t('Failed', 'فشل')}</th>
              <th className="py-2 text-end font-medium">{t('Not made', 'لم يُجرَ')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([check, c]) => (
              <tr key={check} className="border-t border-line">
                <td className="py-2 pe-3 text-heading">{checkName(check, f)}</td>
                <td className="py-2 pe-3 text-end tabular-nums">{f.n(c.pass)}</td>
                <td className="py-2 pe-3 text-end tabular-nums">{f.n(c.fail)}</td>
                <td className="py-2 text-end tabular-nums text-ink-quiet">{f.n(c.unreadable)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}
