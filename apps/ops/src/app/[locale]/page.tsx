/**
 * The origination dashboard.
 *
 * Two questions, answered in order: what is waiting for me, and how does work
 * get in here at all.
 *
 * The channel panel deliberately shows readiness rather than only what is
 * built. Two capabilities beneath it are not available — one waiting on a
 * Board question about what goods an embedded Murabaha actually trades, one
 * excluded from this phase by the specification. Putting that on the operating
 * surface, where a delivery lead sees it daily, is a better guard than a
 * paragraph in a document.
 */

import { notFound } from 'next/navigation';

import { Card, Status } from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import {
  type Readiness,
  channelCards,
  reviewQueue,
  servicingCapabilities,
} from '../../server/origination.ts';

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
}: {
  readonly params: Promise<{ readonly locale: string }>;
}) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);

  const [channels, queue, capabilities] = await Promise.all([
    channelCards(),
    reviewQueue(),
    servicingCapabilities(),
  ]);

  const awaiting = queue.filter((q) => q.state === 'AWAITING_REVIEW');

  return (
    <div className="flex flex-col gap-8">
      {/* -- What needs attention -------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold">
            {arabic ? 'طلبات بانتظار المراجعة' : 'Awaiting review'}
          </h1>
          <span className="text-sm text-ink-quiet tabular-nums">
            {awaiting.length} {arabic ? 'طلب' : 'open'}
          </span>
        </div>

        <ul className="flex list-none flex-col gap-2 p-0">
          {queue.map((item) => (
            <li key={item.requestId}>
              <Card>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="identifier text-sm text-ink-quiet">{item.requestId}</span>
                  <span className="font-medium">
                    {arabic ? item.counterpartyAr : item.counterpartyEn}
                  </span>
                  <span className="text-base font-semibold tabular-nums">
                    <bdi>
                      {formatMinorUnits(
                        { minorUnits: item.amountMinorUnits, currency: 'SAR' },
                        numerals,
                      )}
                    </bdi>{' '}
                    <span className="text-xs text-ink-quiet">SAR</span>
                  </span>

                  <div className="ms-auto flex items-center gap-2">
                    <span className="text-xs text-ink-quiet">
                      {arabic ? 'عبر' : 'via'} {item.channel.replaceAll('_', ' ').toLowerCase()}
                    </span>
                    <Status
                      tone={item.state === 'AWAITING_REVIEW' ? 'progress' : 'blocked'}
                      label={
                        item.state === 'AWAITING_REVIEW'
                          ? `${String(item.waitingHours)}h waiting`
                          : 'Returned to maker'
                      }
                    />
                  </div>
                </div>

                <p className="mt-2 text-xs text-ink-quiet">
                  {arabic ? 'أدخله' : 'Keyed by'}{' '}
                  <span className="identifier">{item.makerPrincipalId}</span>
                  {' — '}
                  {arabic
                    ? 'لا يمكن للمُدخِل اعتماد طلبه'
                    : 'the maker cannot approve their own request'}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      {/* -- How work arrives ------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {arabic ? 'قنوات إنشاء الطلبات' : 'Origination channels'}
          </h2>
          <p className="mt-1 text-sm text-ink-quiet">
            {arabic
              ? 'تختلف القنوات في من يبدأ الطلب وما يُحفظ كدليل. ولا تختلف في الضوابط: كل قناة تنتهي إلى نفس المسار ونفس البوابات الثلاث.'
              : 'Channels differ in who may initiate and what is retained as evidence. They do not differ in sequencing — every channel converges on the same transaction and the same three gates.'}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {channels.map((card) => {
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

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-quiet">
                  {card.requiresFourEyes ? (
                    <span className="rounded-full border border-line px-2 py-0.5">
                      {arabic ? 'مراجعة من شخصين' : 'Four eyes'}
                    </span>
                  ) : null}
                  {card.readiness.kind === 'LIVE' ? (
                    <span className="tabular-nums">
                      {card.openRequests} {arabic ? 'قيد المراجعة' : 'awaiting review'}
                    </span>
                  ) : null}
                </div>

                {note !== undefined ? (
                  <p className="mt-3 border-t border-line pt-3 text-xs text-ink-quiet">{note}</p>
                ) : null}
              </Card>
            );
          })}
        </div>
      </section>

      {/* -- Servicing capabilities, and what is holding them ------------ */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          {arabic ? 'قدرات الخدمة' : 'Servicing capabilities'}
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          {capabilities.map((card) => (
            <Card key={card.id} muted>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-medium">{arabic ? card.titleAr : card.titleEn}</h3>
                {readinessBadge(card.readiness)}
              </div>
              <p className="mt-2 text-sm text-ink-quiet">{card.summaryEn}</p>
              <p className="mt-3 border-t border-line pt-3 text-xs text-ink-quiet">
                {readinessNote(card.readiness)}
              </p>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
