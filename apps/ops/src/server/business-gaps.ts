/**
 * Document gaps on a business application, and asking the applicant for them
 * (document intelligence D4, docs/DOCUMENT-INTELLIGENCE-PLAN.md).
 *
 * The gaps come from the checklist and the findings (core/documents/gaps.ts).
 * An officer asks for them; the request is one notification on the outbox per
 * distinct gap set. When a document arrives — uploaded, or accepted by the
 * checker — and no gap is left, the application records that the documents
 * were received, and the officer's queue shows the case ready again.
 *
 * Nothing here decides a document: the gaps are what the checklist and the
 * findings already say, and the checker's four-eyes validation stands.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type DocumentGap, type FindingChecks, gapsOf } from '@sanad/core/documents/gaps.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { findingsFor } from '@sanad/origination/documents/findings.ts';

import {
  type BusinessApplicationView,
  checklistStatus,
  getApplication,
  recordDocumentRequest,
  recordDocumentsReceived,
  validateDocument,
} from './business.ts';

/** What the application still needs from the applicant, now. */
export async function documentGaps(tenant: TenantCode, applicationId: string): Promise<Result<readonly DocumentGap[]>> {
  const view = await getApplication(tenant, applicationId);
  if (view === undefined)
    return reject('OP-DETERMINACY', 'BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  const checklist = await checklistStatus(tenant, applicationId);
  if (!checklist.ok) return checklist;
  const findings = await findingsFor(tenant, { kind: 'BUSINESS_APPLICATION', ref: applicationId });
  // The document an item stands on is its latest presentation; its latest reading gives the checks.
  const checksFor = (documentType: string): FindingChecks | undefined => {
    const latest = [...view.documents].reverse().find((d) => d.documentType === documentType);
    const sha = latest?.content?.sha256Hex;
    return sha === undefined ? undefined : findings.get(sha)?.checks;
  };
  return ok(gapsOf(checklist.value.report, checksFor));
}

/** Ask the applicant for every gap, by one notification. Refused where there is none. */
export async function requestMissingDocuments(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const gaps = await documentGaps(tenant, applicationId);
  if (!gaps.ok) return gaps;
  return recordDocumentRequest(tenant, applicationId, gaps.value, actor);
}

/**
 * After a document arrives: where a request is open and no gap is left, record
 * that the documents were received. Otherwise nothing — a gap still open stays
 * the officer's to chase, and a new gap is a new request.
 */
export async function resumeIfComplete(tenant: TenantCode, applicationId: string, actor: string): Promise<void> {
  const view = await getApplication(tenant, applicationId);
  if (view?.documentRequest?.status !== 'AWAITING') return;
  const gaps = await documentGaps(tenant, applicationId);
  if (gaps.ok && gaps.value.length === 0) await recordDocumentsReceived(tenant, applicationId, actor);
}

/** The checker's validation, then the resume check: accepting the last failing document can close the request. */
export async function validateDocumentAndResume(
  ...args: Parameters<typeof validateDocument>
): Promise<Result<BusinessApplicationView>> {
  const validated = await validateDocument(...args);
  if (!validated.ok) return validated;
  const [tenant, applicationId, , , validator] = args;
  await resumeIfComplete(tenant, applicationId, validator);
  return ok((await getApplication(tenant, applicationId)) ?? validated.value);
}
