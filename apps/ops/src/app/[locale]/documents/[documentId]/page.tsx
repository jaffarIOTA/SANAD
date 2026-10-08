/**
 * One document in the viewer — verification check V-01: does the licence
 * activate on this origin, and which features does the SDK report? Until a
 * licence key is configured the SDK runs in evaluation mode and this page says
 * so rather than hiding it.
 */

import { notFound } from 'next/navigation';

import { BUTTON_SECONDARY, Card, Status } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { findViewerDocument, viewerLicence } from '../../../../server/documents.ts';
import { Viewer } from './Viewer.tsx';

export default async function DocumentPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string; readonly documentId: string }>;
}) {
  const { locale: segment, documentId } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const doc = findViewerDocument(documentId);
  if (doc === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const licence = await viewerLicence();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-heading">{arabic ? doc.titleAr : doc.titleEn}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-[15px] text-ink-quiet">
            <span className="identifier">{doc.documentId}</span>
            <Status tone="progress" label={arabic ? 'بيانات اصطناعية' : 'synthetic data'} />
            <Status
              tone={licence.kind === 'LICENSED' ? 'settled' : 'blocked'}
              label={
                licence.kind === 'LICENSED'
                  ? arabic
                    ? 'ترخيص مفعّل'
                    : 'licence active'
                  : arabic
                    ? 'وضع التقييم — لا ترخيص'
                    : 'evaluation mode — no licence key'
              }
            />
          </p>
        </div>
        <a href={`/${segment}/documents`} className={BUTTON_SECONDARY}>
          {arabic ? 'كل المستندات' : 'All documents'}
        </a>
      </div>
      <Card>
        <Viewer
          documentUrl={`/api/documents/v1/artefacts/${doc.documentId}`}
          arabic={arabic}
          {...(licence.kind === 'LICENSED' ? { licenseKey: licence.licenseKey } : {})}
        />
      </Card>
    </div>
  );
}
