/** The record of acceptance: which disclosure, under which identity assertion, when. */

import { notFound, redirect } from 'next/navigation';

import { Card, Status } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { currentSession } from '../../../../../server/session.ts';
import { acceptanceFor, findOffer } from '../../../../../server/store.ts';

export default async function AcceptedPage({ params }: { readonly params: Promise<{ readonly locale: string; readonly offerId: string }> }) {
  const { locale: segment, offerId } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const session = await currentSession();
  if (session === undefined) redirect(`/${segment}`);
  const stored = findOffer(offerId);
  const acceptance = acceptanceFor(offerId);
  if (stored === undefined || acceptance === undefined || stored.applicantRef !== session.applicantRef) notFound();

  const rows: readonly [string, string][] = [
    [arabic ? 'رقم القبول' : 'Acceptance', acceptance.acceptanceId],
    [arabic ? 'العرض' : 'Offer', offerId],
    [arabic ? 'إصدار الإفصاح المقبول' : 'Disclosure version accepted', acceptance.disclosureVersion.slice(0, 16)],
    [arabic ? 'مرجع التحقق من الهوية' : 'Identity assertion', acceptance.identityAssertionId],
    [arabic ? 'اللغة المعروضة' : 'Language shown', acceptance.localeShown],
    [arabic ? 'وقت القبول (موثّق)' : 'Accepted at (attested)', new Date(Number(acceptance.acceptedAt.epochSeconds) * 1000).toISOString()],
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <h1 className="text-h1 font-semibold text-heading">{arabic ? 'تم القبول' : 'Accepted'}</h1>
        <Status tone="settled" label={arabic ? 'مسجَّل' : 'recorded'} />
      </div>
      <p className="text-[15px] text-ink-quiet">{arabic ? 'سُجِّل قبولك للإفصاح الذي عُرض عليك، مربوطاً بمرجع التحقق من هويتك. تبدأ الآن خطوات التنفيذ الخاصة بالمنتج.' : 'Your acceptance of the disclosure shown to you is recorded, bound to your identity assertion. The product’s execution steps begin now.'}</p>
      <Card>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-ink-quiet">{k}</dt><dd className="identifier truncate text-ink">{v}</dd></div>))}
        </dl>
      </Card>
      <a href={`/${segment}/apply`} className="text-center text-sm text-brand">{arabic ? 'طلب آخر' : 'Another application'}</a>
    </div>
  );
}
