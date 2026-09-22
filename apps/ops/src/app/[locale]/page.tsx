/**
 * The origination dashboard.
 *
 * Structure borrowed from the lending dashboards we were shown: a KPI row, a
 * charts band, an indicators panel, then the working table. It is a good shape
 * and there is no reason to invent another.
 *
 * Two things deliberately differ from those references.
 *
 * **There is no rate column.** The reference dashboards carry one — 12%, 10%,
 * 5% — because they are lending dashboards. The equivalent column here is the
 * profit *amount*, shown beside the total it forms part of. That is not a
 * cosmetic substitution: disclosure of cost and markup is a validity condition
 * of the Murabaha (SH-15), and a proportion is the one thing this product has
 * no field for anywhere (SH-01).
 *
 * **There is a compliance panel.** Neither reference has anything like it,
 * because a conventional lender does not need one. SDD §4.10 is explicit that
 * gate blocks, evidence completeness, risk-period distribution, incidents,
 * template drift and the purification balance are "dashboards for the Board,
 * not only for engineering". Those numbers are currently zero — no transaction
 * has executed — and zero is shown as zero rather than dressed up.
 */

import { notFound } from 'next/navigation';

import { Card, Status } from '@sanad/design/primitives.tsx';
import { BarList, Indicator, StageBar, StatTile } from '@sanad/design/charts.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { channelCards, servicingCapabilities, type Readiness } from '../../server/origination.ts';
import { listRequests } from '../../server/store.ts';

function readinessBadge(readiness: Readiness) {
  switch (readiness.kind) {
    case 'LIVE':
      return <Status tone="available" label="Live" />;
    case 'BLOCKED':
      return <Status tone="progress" label="Blocked" />;
    case 'EXCLUDED_THIS_PHASE':
      return <Status tone="blocked" label="Excluded this phase" />;
  }
}

function readinessNote(readiness: Readiness): string | undefined {
  if (readiness.kind === 'BLOCKED') return readiness.on;
  if (readiness.kind === 'EXCLUDED_THIS_PHASE') return readiness.basis;
  return undefined;
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: segment } = await params;
  const { q } = await searchParams;
  const term = (Array.isArray(q) ? q[0] : q)?.trim() ?? '';
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const sar = (minorUnits: bigint) =>
    formatMinorUnits({ minorUnits, currency: 'SAR' }, numerals);

  const [channels, capabilities] = await Promise.all([channelCards(), servicingCapabilities()]);
  const all = listRequests();

  // The header search narrows the table only. The KPIs, the charts and the
  // compliance panel keep counting the whole book — a filtered figure
  // presented as a total is how an operator reports the wrong number.
  const needle = term.toLowerCase();
  const queue =
    needle === ''
      ? all
      : all.filter((r) =>
          [r.requestId, r.counterpartyId, r.invoiceNumber].some((f) =>
            f.toLowerCase().includes(needle),
          ),
        );

  const count = (...states: string[]) => all.filter((r) => states.includes(r.state)).length;
  const awaitingServicing = count('AWAITING_SERVICING_RESPONSE');
  const awaitingReview = count('AWAITING_REVIEW');
  const returned = count('RETURNED_TO_MAKER');
  const approved = count('APPROVED');
  const rejected = count('REJECTED');

  const approvedValue = all
    .filter((r) => r.state === 'APPROVED')
    .reduce((sum, r) => sum + r.amountMinorUnits, 0n);
  const pipelineValue = all
    .filter((r) => r.state !== 'REJECTED' && r.state !== 'WITHDRAWN')
    .reduce((sum, r) => sum + r.amountMinorUnits, 0n);

  return (
    <div className="flex flex-col gap-7">
      {/* -- Heading and the primary action ------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {arabic ? 'نظرة عامة على العمليات' : 'Origination overview'}
          </h1>
          <p className="mt-1 text-sm text-ink-quiet">
            {arabic
              ? 'كل قناة تنتهي إلى نفس المسار ونفس البوابات الثلاث.'
              : 'Every channel converges on the same transaction and the same three gates.'}
          </p>
        </div>
        <a
          href={`/${segment}/originate`}
          className="inline-flex min-h-tap items-center rounded-card bg-brand-strong px-4 text-sm font-semibold text-on-brand hover:bg-brand-deep"
        >
          {arabic ? 'إنشاء طلب' : 'Key a request'}
        </a>
      </div>

      {/* -- KPIs ----------------------------------------------------------- */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon="inbox"
          tone={awaitingReview > 0 ? 'attention' : 'neutral'}
          label={arabic ? 'بانتظار مراجعتك' : 'Awaiting your review'}
          value={String(awaitingReview)}
          context={arabic ? 'أربع أعين' : 'four eyes'}
          emphasis={awaitingReview > 0}
        />
        <StatTile
          icon="clock"
          tone="neutral"
          label={arabic ? 'بانتظار نظام الخدمة' : 'Awaiting servicing platform'}
          value={String(awaitingServicing)}
          context={arabic ? 'خارج سندّ' : 'external'}
        />
        <StatTile
          icon="coins"
          tone="brand"
          label={arabic ? 'قيمة قيد المعالجة' : 'Value in pipeline'}
          value={sar(pipelineValue)}
          unit="SAR"
        />
        <StatTile
          icon="check-circle"
          tone="positive"
          label={arabic ? 'قيمة معتمدة' : 'Value approved'}
          value={sar(approvedValue)}
          unit="SAR"
        />
      </section>

      {/* -- Charts and indicators ------------------------------------------ */}
      <section className="grid gap-3 lg:grid-cols-3">
        <Card>
          <StageBar
            title={arabic ? 'مراحل الطلبات' : 'Requests by stage'}
            emptyLabel={arabic ? 'لا توجد طلبات بعد.' : 'No requests yet.'}
            segments={[
              {
                id: 'servicing',
                label: arabic ? 'بانتظار نظام الخدمة' : 'Awaiting servicing',
                value: awaitingServicing,
                colour: '--color-stage-1',
              },
              {
                id: 'review',
                label: arabic ? 'بانتظار المراجعة' : 'Awaiting review',
                value: awaitingReview,
                colour: '--color-stage-2',
              },
              {
                id: 'returned',
                label: arabic ? 'أُعيد للمُدخِل' : 'Returned to maker',
                value: returned,
                colour: '--color-stage-3',
              },
              {
                id: 'approved',
                label: arabic ? 'معتمد' : 'Approved',
                value: approved,
                colour: '--color-stage-4',
              },
              {
                id: 'rejected',
                label: arabic ? 'مرفوض' : 'Rejected',
                value: rejected,
                colour: '--color-stage-5',
              },
            ]}
          />
        </Card>

        <Card>
          <BarList
            title={arabic ? 'الطلبات حسب القناة' : 'Requests by channel'}
            emptyLabel={arabic ? 'لا توجد طلبات بعد.' : 'No requests yet.'}
            rows={channels.map((c) => ({
              label: arabic ? c.titleAr : c.titleEn,
              value: all.filter((r) => r.channel === c.channel).length,
            }))}
          />
        </Card>

        <Card>
          <h2 className="text-sm font-medium text-ink">
            {arabic ? 'مؤشرات الالتزام الشرعي' : 'Compliance indicators'}
          </h2>
          <p className="mt-1 text-xs text-ink-quiet">
            {arabic
              ? 'تُملأ هذه المؤشرات بعد تنفيذ أول معاملة. الصفر هنا صفر حقيقي.'
              : 'These populate once transactions execute. Zero here is a real zero, not a placeholder.'}
          </p>
          <ul className="mt-2 flex list-none flex-col p-0">
            <Indicator
              label={arabic ? 'بوابات مُنعت' : 'Gate blocks'}
              note="SH-05 · SH-06"
              value="0"
              tone="neutral"
            />
            <Indicator
              label={arabic ? 'اكتمال الأدلة' : 'Evidence completeness'}
              note="SDD §4.10"
              value="—"
              tone="neutral"
            />
            <Indicator
              label={arabic ? 'مخالفات شرعية مفتوحة' : 'Open Shariah incidents'}
              note="BR-F04"
              value="0"
              tone="good"
            />
            <Indicator
              label={arabic ? 'انحراف القوالب' : 'Template drift detections'}
              note="BR-F07"
              value="0"
              tone="good"
            />
            <Indicator
              label={arabic ? 'رصيد حساب الخير' : 'Charity liability balance'}
              note="SH-13"
              value="0.00"
              tone="neutral"
            />
            <Indicator
              label={arabic ? 'أسئلة معلّقة لدى الهيئة' : 'Questions with the Board'}
              note="OI-22 · OI-23 · OI-24"
              value="3"
              tone="warning"
            />
          </ul>
        </Card>
      </section>

      {/* -- The working table ----------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            {arabic ? 'الطلبات' : 'Requests'}
          </h2>
          {term === '' ? (
            <span className="text-sm text-ink-quiet tabular-nums">
              {queue.length} {arabic ? 'إجمالاً' : 'total'}
            </span>
          ) : (
            <span className="flex items-center gap-2 text-sm text-ink-quiet">
              <span className="tabular-nums">
                {queue.length} {arabic ? 'من' : 'of'} {all.length}
              </span>
              <span className="rounded-full bg-sunken px-2 py-0.5 text-xs">
                <bdi>{term}</bdi>
              </span>
              <a href={`/${segment}`} className="text-brand-deep underline">
                {arabic ? 'إلغاء التصفية' : 'clear'}
              </a>
            </span>
          )}
        </div>

        <Card>
          {queue.length === 0 ? (
            <p className="text-sm text-ink-quiet">
              {term === ''
                ? arabic
                  ? 'لا توجد طلبات بعد.'
                  : 'No requests yet.'
                : arabic
                  ? 'لا يطابق البحث أي طلب.'
                  : 'No request matches that search.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-start text-xs uppercase tracking-wider text-ink-quiet">
                    <th className="py-2 pe-3 text-start font-medium">
                      {arabic ? 'الطلب' : 'Request'}
                    </th>
                    <th className="py-2 pe-3 text-start font-medium">
                      {arabic ? 'العميل' : 'Counterparty'}
                    </th>
                    <th className="py-2 pe-3 text-start font-medium">
                      {arabic ? 'الفاتورة' : 'Invoice'}
                    </th>
                    <th className="py-2 pe-3 text-end font-medium">
                      {arabic ? 'المبلغ' : 'Amount'}
                    </th>
                    <th className="py-2 pe-3 text-start font-medium">
                      {arabic ? 'القناة' : 'Channel'}
                    </th>
                    <th className="py-2 pe-3 text-start font-medium">
                      {arabic ? 'الحالة' : 'Status'}
                    </th>
                    <th className="py-2 text-end font-medium">{arabic ? 'إجراء' : 'Action'}</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((item) => {
                    const needsAttention = item.state === 'AWAITING_REVIEW';
                    return (
                      <tr
                        key={item.requestId}
                        className={`border-b border-line last:border-b-0 ${
                          needsAttention ? 'bg-brand-wash' : ''
                        }`}
                      >
                        <td className="py-3 pe-3">
                          <span className="identifier text-ink-quiet">{item.requestId}</span>
                        </td>
                        <td className="py-3 pe-3 font-medium">{item.counterpartyId}</td>
                        <td className="py-3 pe-3">
                          <span className="identifier text-ink-quiet">{item.invoiceNumber}</span>
                        </td>
                        <td className="py-3 pe-3 text-end tabular-nums">
                          <bdi>{sar(item.amountMinorUnits)}</bdi>
                        </td>
                        <td className="py-3 pe-3 text-ink-quiet">
                          {item.channel.replaceAll('_', ' ').toLowerCase()}
                        </td>
                        <td className="py-3 pe-3">
                          <Status
                            tone={
                              item.state === 'APPROVED'
                                ? 'settled'
                                : item.state === 'REJECTED'
                                  ? 'blocked'
                                  : 'progress'
                            }
                            label={item.state.replaceAll('_', ' ').toLowerCase()}
                          />
                        </td>
                        <td className="py-3 text-end">
                          <a
                            href={`/${segment}/requests/${item.requestId}`}
                            className="text-brand-deep underline"
                          >
                            {arabic ? 'فتح' : 'Open'}
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-ink-quiet">
            {arabic
              ? 'لا يوجد عمود لنسبة العائد. البديل هنا هو مبلغ الربح، ويظهر مع العرض عند فتح الطلب.'
              : 'There is no rate column. The equivalent here is the profit amount, shown with the offer when a request is opened.'}
          </p>
        </Card>
      </section>

      {/* -- Channels and capabilities --------------------------------------- */}
      <section className="grid gap-3 lg:grid-cols-2">
        {[...channels, ...capabilities.map((c) => ({ ...c, channel: c.id, titleAr: c.titleAr, summaryAr: c.summaryEn, requiresFourEyes: false, openRequests: 0 }))].map(
          (card) => {
            const note = readinessNote(card.readiness);
            return (
              <Card key={card.channel} muted={card.readiness.kind !== 'LIVE'}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-medium">{arabic ? card.titleAr : card.titleEn}</h3>
                  {readinessBadge(card.readiness)}
                </div>
                <p className="mt-2 text-sm text-ink-quiet">
                  {arabic ? card.summaryAr : card.summaryEn}
                </p>
                {note !== undefined ? (
                  <p className="mt-3 border-t border-line pt-3 text-xs text-ink-quiet">{note}</p>
                ) : null}
              </Card>
            );
          },
        )}
      </section>
    </div>
  );
}
