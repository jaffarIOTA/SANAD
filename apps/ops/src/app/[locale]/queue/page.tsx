/**
 * The review queue.
 *
 * A work queue, not a table of everything. It answers one question — what
 * needs a decision from me, oldest first — and keeps the other views a click
 * away rather than mixed in.
 *
 * Four decisions here are worth stating, because each of them is the opposite
 * of what a conventional lending queue does.
 *
 * **Oldest first, always.** A queue sorted newest-first starves its tail, and
 * the tail is where a counterparty has been waiting longest. Ordering is FIFO
 * on the attested submission time and there is no control to reverse it.
 *
 * **Your own work is shown, and blocked.** Four eyes means the maker cannot be
 * the checker. Hiding those rows would be tidier and worse: someone would
 * assume the request was lost. They appear, marked, with the reason, and
 * without an action. The *control* is in the domain, which refuses the
 * transition regardless — this is only the explanation.
 *
 * **No bulk approve.** There is no select-all and no "approve 5 selected".
 * Reviewing means looking at the trade; a checkbox column is a way of not
 * looking at it. If volume makes this painful, the answer is more reviewers or
 * a straight-through policy that is explicit about what it skips — not a
 * button that makes the skipping invisible.
 *
 * **Ageing is operational only.** The times below drive display and ordering.
 * No gate is evaluated from them. Gate timing comes from the timestamping
 * authority through `core/sequencing`, which this page cannot reach (SH-06).
 */

import { notFound } from 'next/navigation';

import { Card, Status } from '@sanad/design/primitives.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { CHECKER, canReview } from '../../../server/session.ts';
import { listRequests, type RequestRow } from '../../../server/store.ts';

type View = 'review' | 'servicing' | 'maker' | 'decided';

const VIEWS: readonly View[] = ['review', 'servicing', 'maker', 'decided'];

const VIEW_STATES: Readonly<Record<View, readonly RequestRow['state'][]>> = {
  review: ['AWAITING_REVIEW'],
  servicing: ['AWAITING_SERVICING_RESPONSE'],
  maker: ['RETURNED_TO_MAKER', 'KEYING'],
  decided: ['APPROVED', 'REJECTED', 'WITHDRAWN'],
};

const VIEW_LABEL: Readonly<Record<View, { en: string; ar: string }>> = {
  review: { en: 'Needs your decision', ar: 'بانتظار قرارك' },
  servicing: { en: 'With the servicing platform', ar: 'لدى نظام الخدمة' },
  maker: { en: 'With the maker', ar: 'لدى المُدخِل' },
  decided: { en: 'Decided', ar: 'تم البت فيها' },
};

const VIEW_EMPTY: Readonly<Record<View, { en: string; ar: string }>> = {
  review: { en: 'Nothing is waiting on you.', ar: 'لا يوجد ما ينتظر قرارك.' },
  servicing: {
    en: 'Nothing is with the servicing platform.',
    ar: 'لا يوجد لدى نظام الخدمة شيء.',
  },
  maker: { en: 'Nothing has been returned.', ar: 'لم يُعَد أي طلب.' },
  decided: { en: 'Nothing has been decided yet.', ar: 'لم يتم البت في أي طلب بعد.' },
};

function isView(value: string | undefined): value is View {
  return value !== undefined && (VIEWS as readonly string[]).includes(value);
}

/**
 * How long a row has been waiting, in the reader's language.
 *
 * Reads the wall clock, deliberately and only here. This is the age of a task
 * in an inbox — the same kind of fact as "unread for two days" — and it is
 * never compared against a Board parameter. The value it is measured from is
 * attested; the comparison is not, and does not need to be.
 */
function age(sinceEpochSeconds: bigint, nowEpochSeconds: bigint, locale: string): string {
  const seconds = Number(nowEpochSeconds - sinceEpochSeconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (seconds < 60) return format.format(-Math.max(seconds, 1), 'second');
  if (seconds < 3_600) return format.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return format.format(-Math.floor(seconds / 3_600), 'hour');
  return format.format(-Math.floor(seconds / 86_400), 'day');
}

function waitingSince(row: RequestRow): bigint {
  return row.submittedAtEpochSeconds ?? row.raisedAtEpochSeconds;
}

export default async function QueuePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: segment } = await params;
  const raw = (await searchParams)['show'];
  const requested = Array.isArray(raw) ? raw[0] : raw;
  const view: View = isView(requested) ? requested : 'review';

  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const text = (pair: { en: string; ar: string }): string => (arabic ? pair.ar : pair.en);
  const numerals = defaultNumerals(locale);
  const sar = (minorUnits: bigint): string =>
    formatMinorUnits({ minorUnits, currency: 'SAR' }, numerals);

  // Read once, so every row on the page is aged against the same instant.
  const nowEpochSeconds = BigInt(Math.floor(Date.now() / 1000));

  const all = listRequests();
  const counts = Object.fromEntries(
    VIEWS.map((v) => [v, all.filter((r) => VIEW_STATES[v].includes(r.state)).length]),
  ) as Record<View, number>;

  /*
   * Oldest first in the working views: a queue, not a feed. Decided items
   * read better newest-first, because that is a log rather than a backlog.
   *
   * The tie-break matters more than it looks. Attested timestamps have
   * one-second granularity, so a batch that arrives together — an aggregator
   * posting overnight, or a seeded fixture — ties on the second and would
   * otherwise fall back to whatever order the repository happened to return,
   * which is descending. That silently inverts a FIFO queue. Request
   * identifiers are monotonic, so they settle it deterministically.
   */
  const rows = all
    .filter((r) => VIEW_STATES[view].includes(r.state))
    .sort((a, b) => {
      const direction = view === 'decided' ? -1 : 1;
      const byTime = Number(waitingSince(a) - waitingSince(b));
      if (byTime !== 0) return direction * byTime;
      return direction * a.requestId.localeCompare(b.requestId);
    });

  const blockedCount = all.filter(
    (r) => r.state === 'AWAITING_REVIEW' && !canReview(CHECKER, r.makerPrincipalId).allowed,
  ).length;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Icon name="queue" size={20} />
            {arabic ? 'قائمة المراجعة' : 'Review queue'}
          </h1>
          <p className="mt-1 text-sm text-ink-quiet">
            {arabic
              ? 'الأقدم أولاً. الاعتماد يفتح معاملة في حالة مسودة، ولا يتجاوز أي بوابة.'
              : 'Oldest first. Approving opens a transaction in DRAFT; it passes no gate.'}
          </p>
        </div>
        <span className="rounded-card border border-line bg-surface px-3 py-2 text-xs text-ink-quiet">
          {arabic ? 'تُراجع بصفة' : 'Reviewing as'}{' '}
          <span className="identifier text-ink">{CHECKER.principalId}</span>
        </span>
      </div>

      {/* -- Views ---------------------------------------------------------- */}
      <nav aria-label={arabic ? 'طرق العرض' : 'Queue views'}>
        <ul className="flex list-none flex-wrap gap-2 p-0">
          {VIEWS.map((v) => {
            const active = v === view;
            return (
              <li key={v}>
                <a
                  href={`/${segment}/queue?show=${v}`}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-tap items-center gap-2 rounded-card border px-3 text-sm ${
                    active
                      ? 'border-brand-strong bg-brand-wash font-semibold text-brand-deep'
                      : 'border-line bg-surface text-ink hover:bg-sunken'
                  }`}
                >
                  {text(VIEW_LABEL[v])}
                  <span className="rounded-full bg-sunken px-2 text-xs tabular-nums text-ink-quiet">
                    {counts[v]}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {view === 'review' && blockedCount > 0 ? (
        <p className="flex items-start gap-2 rounded-card border border-line bg-sunken p-3 text-sm text-ink-quiet">
          <Icon name="shield-check" size={16} className="mt-0.5 shrink-0" />
          <span>
            {arabic
              ? `${String(blockedCount)} من هذه الطلبات أدخلتَها بنفسك، فلا يمكنك اعتمادها. تظهر هنا ليعلم غيرك بوجودها.`
              : `${String(blockedCount)} of these were keyed by you, so you cannot approve them. They are listed so nobody assumes they were lost.`}
          </span>
        </p>
      ) : null}

      {/* -- The queue ------------------------------------------------------ */}
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-quiet">{text(VIEW_EMPTY[view])}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                {text(VIEW_LABEL[view])} — {rows.length}
              </caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wider text-ink-quiet">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {arabic ? 'منذ' : 'Waiting'}
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {arabic ? 'العميل' : 'Counterparty'}
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {arabic ? 'الفاتورة' : 'Invoice'}
                  </th>
                  <th scope="col" className="py-2 pe-3 text-end font-medium">
                    {arabic ? 'المبلغ' : 'Amount'}
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {arabic ? 'القناة' : 'Channel'}
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {arabic ? 'نظام الخدمة' : 'Servicing'}
                  </th>
                  <th scope="col" className="py-2 text-end font-medium">
                    {arabic ? 'إجراء' : 'Action'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const review = canReview(CHECKER, row.makerPrincipalId);
                  const ownWork = view === 'review' && !review.allowed;
                  const declined = row.servicing?.decision === 'DECLINED';

                  return (
                    <tr key={row.requestId} className="border-b border-line last:border-b-0">
                      <td className="py-3 pe-3 text-ink-quiet">
                        {age(waitingSince(row), nowEpochSeconds, locale)}
                      </td>

                      <td className="py-3 pe-3">
                        <span className="font-medium">{row.counterpartyId}</span>
                        <span className="block text-xs">
                          <span className="identifier text-ink-quiet">{row.requestId}</span>
                        </span>
                      </td>

                      <td className="py-3 pe-3">
                        <span className="identifier text-ink-quiet">{row.invoiceNumber}</span>
                      </td>

                      <td className="py-3 pe-3 text-end tabular-nums">
                        <bdi>{sar(row.amountMinorUnits)}</bdi>
                        <span className="ms-1 text-xs text-ink-quiet">SAR</span>
                      </td>

                      <td className="py-3 pe-3 text-ink-quiet">
                        {row.channel.replaceAll('_', ' ').toLowerCase()}
                      </td>

                      <td className="py-3 pe-3">
                        {row.servicing === undefined ? (
                          <span className="text-ink-quiet">
                            {row.state === 'AWAITING_SERVICING_RESPONSE'
                              ? arabic
                                ? 'بانتظار الرد'
                                : 'awaiting'
                              : '—'}
                          </span>
                        ) : (
                          <span className="flex flex-col gap-0.5">
                            <Status
                              tone={
                                row.servicing.decision === 'APPROVED'
                                  ? 'settled'
                                  : row.servicing.decision === 'DECLINED'
                                    ? 'blocked'
                                    : 'progress'
                              }
                              label={row.servicing.decision.toLowerCase()}
                            />
                            {declined ? (
                              <span className="text-xs text-attention">
                                {arabic
                                  ? 'الاعتماد يتطلب تسبيباً مكتوباً'
                                  : 'approval needs a written justification'}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>

                      <td className="py-3 text-end">
                        {ownWork ? (
                          // Shown, not hidden, and not actionable. The domain
                          // refuses this transition too — see `approve()`.
                          <span
                            className="inline-flex flex-col items-end text-xs text-ink-quiet"
                            title={
                              arabic
                                ? 'المُدخِل لا يعتمد عمله'
                                : 'The principal who raised a request cannot approve it'
                            }
                          >
                            <span className="font-medium text-attention">
                              {arabic ? 'من إدخالك' : 'your own work'}
                            </span>
                            <span>{arabic ? 'يلزم مراجع آخر' : 'needs another reviewer'}</span>
                          </span>
                        ) : (
                          <a
                            href={`/${segment}/requests/${row.requestId}`}
                            className="inline-flex min-h-tap items-center rounded-card border border-line px-3 text-sm font-medium text-brand-deep hover:bg-sunken"
                          >
                            {view === 'review'
                              ? arabic
                                ? 'مراجعة'
                                : 'Review'
                              : arabic
                                ? 'فتح'
                                : 'Open'}
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-quiet">
          {arabic
            ? 'لا يوجد اعتماد جماعي. المراجعة تعني النظر في الصفقة، وخانة الاختيار وسيلة لعدم النظر فيها.'
            : 'There is no bulk approve. Reviewing means looking at the trade, and a checkbox column is a way of not looking at it.'}
        </p>
      </Card>
    </div>
  );
}
