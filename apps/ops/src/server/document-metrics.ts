/**
 * The document throughput view's figures (document intelligence D5) for a
 * tenant's business applications: each document as presented, the checker's
 * decision on it and when, and the checks on its latest reading — measured by
 * the pure `documentMetrics`. Read only; it changes nothing.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type DocumentMetrics, type MeasuredSubject, documentMetrics } from '@sanad/core/documents/metrics.ts';
import { findingsForKind } from '@sanad/origination/documents/findings.ts';

import { type BusinessApplicationView, checklistStatus, listApplications } from './business.ts';

/** When the checker decided a document: the validation event after its presentation that names it. */
function decidedAt(v: BusinessApplicationView, documentRef: string, presentedAt: bigint): bigint | undefined {
  return [...v.events]
    .filter(
      (e) =>
        e.eventType === 'DOCUMENT_VALIDATED' &&
        e.detail['documentRef'] === documentRef &&
        e.atEpochSeconds >= presentedAt,
    )
    .sort((a, b) => a.sequence - b.sequence)[0]?.atEpochSeconds;
}

export async function businessDocumentMetrics(tenant: TenantCode): Promise<DocumentMetrics> {
  const [views, findings] = await Promise.all([
    listApplications(tenant),
    findingsForKind(tenant, 'BUSINESS_APPLICATION'),
  ]);
  const subjects: MeasuredSubject[] = [];
  for (const v of views) {
    const id = v.application.applicationId;
    const checklist = await checklistStatus(tenant, id);
    const read = findings.get(id);
    subjects.push({
      requiredTypes: checklist.ok
        ? checklist.value.report.filter((r) => r.item.required).map((r) => r.item.documentType)
        : [],
      requests: v.events.filter((e) => e.eventType === 'DOCUMENTS_REQUESTED').length,
      documents: v.documents.map((d) => {
        const presentedAt = d.capturedAt.epochSeconds;
        const decided = d.validationStatus === 'PENDING' ? undefined : decidedAt(v, d.documentRef, presentedAt);
        const checks = d.content === undefined ? undefined : read?.get(d.content.sha256Hex)?.checks;
        return {
          documentType: d.documentType,
          presentedAtEpochSeconds: presentedAt,
          decision: d.validationStatus,
          ...(decided === undefined ? {} : { decidedAtEpochSeconds: decided }),
          ...(checks === undefined ? {} : { checks }),
        };
      }),
    });
  }
  return documentMetrics(subjects);
}
