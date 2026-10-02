/**
 * The documents the workbench can open. Development: the synthetic
 * verification samples. Nothing here is, or resembles, a real applicant's
 * document.
 */

import { notFound } from 'next/navigation';

import { Icon } from '@sanad/design/icons.tsx';
import { Card, PillLink, Status } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { VIEWER_DOCUMENTS, viewerLicence } from '../../../server/documents.ts';

export default async function DocumentsPage({ params }: { readonly params: Promise<{ readonly locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const licence = await viewerLicence();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{arabic ? 'المستندات' : 'Documents'}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {arabic ? 'نماذج اصطناعية لفحص العارض والتوقيع والاستخراج. ' : 'Synthetic samples for the viewer, signature and extraction checks. '}
          {licence.kind === 'LICENSED' ? (arabic ? 'ترخيص العارض مفعّل.' : 'The viewer licence is active.') : (arabic ? 'العارض في وضع التقييم حتى يُحفظ مفتاح الترخيص.' : 'The viewer runs in evaluation mode until a licence key is saved.')}
        </p>
      </div>
      <Card>
        <ul className="flex list-none flex-col divide-y divide-line p-0">
          {VIEWER_DOCUMENTS.map((d) => (
            <li key={d.documentId} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
              <span className="flex min-w-0 items-center gap-4">
                <span aria-hidden className="inline-flex size-[45px] shrink-0 items-center justify-center rounded-full bg-disc-blue text-brand-deep"><Icon name="document" size={20} /></span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[16px] font-medium text-heading">{arabic ? d.titleAr : d.titleEn}</span>
                  <span className="identifier text-xs text-ink-quiet">{d.documentId}</span>
                </span>
              </span>
              <span className="flex items-center gap-3">
                <Status tone="progress" label={arabic ? 'اصطناعي' : 'synthetic'} />
                <PillLink href={`/${segment}/documents/${d.documentId}`}>{arabic ? 'فتح' : 'Open'}</PillLink>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
