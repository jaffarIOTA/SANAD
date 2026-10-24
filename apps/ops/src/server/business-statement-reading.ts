/**
 * Reading figures from an uploaded financial statement (credit assessment,
 * stage 5): the statement's bytes from the tenant's object store, its tables
 * read by the institution's document engine (adapters/nutrient/
 * document-extraction.ts), turned into figures under the tenant's row labels
 * (core/documents/statement-figures.ts), and proposed through the system's
 * own ingestion path (`ingestReadFigures`, principal `system:statement-ocr`,
 * source kind OCR, the statement as the source reference).
 *
 * The officer asks for the reading; the system proposes; a person verifies
 * each figure against the statement before it is used, and a correction is
 * that person's own keyed figure, verified by someone else
 * (core/applicant/financials.ts). The engine runs on the institution's hosts,
 * so the statement does not leave it. An engine that is not configured or
 * does not answer reads nothing, and the officer keys the figures by hand.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { loadStatementReadingPolicy } from '@sanad/config/loader.ts';
import { readStatementFigures } from '@sanad/core/documents/statement-figures.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import { credentialProviderFromEnvironment } from '@sanad/origination/credentials.ts';

import { NutrientDocumentExtraction } from '../../../../adapters/nutrient/document-extraction.ts';
import { type BusinessApplicationView, READ_FIGURE_SOURCES, getApplication, ingestReadFigures } from './business.ts';
import { readBusinessDocument } from './business-storage.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const READABLE_STATUSES: ReadonlySet<string> = new Set(['RECEIVED', 'SPREADING']);

/** Read the figures in one uploaded statement and propose them for verification. */
export async function readFiguresFromStatement(
  tenant: TenantCode,
  applicationId: string,
  documentRef: string,
  correlationId: string,
): Promise<Result<BusinessApplicationView>> {
  const view = await getApplication(tenant, applicationId);
  if (view === undefined) return fail('BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  if (!READABLE_STATUSES.has(view.application.status))
    return fail('TRANSITION_NOT_ALLOWED', 'Figures are read only while the application is in credit assessment', {
      status: view.application.status,
    });
  const policy = loadStatementReadingPolicy(tenant);
  if (!policy.ok) return policy;
  const doc = view.documents.find((d) => d.documentRef === documentRef);
  if (doc === undefined) return fail('SECURITY_EVIDENCE_NOT_ON_FILE', 'Name a document on the application');
  if (!policy.value.documentTypes.includes(doc.documentType))
    return fail('STATEMENT_TYPE_NOT_READ', 'Figures are read only from the financial statements the policy names', {
      documentType: doc.documentType,
    });
  if (doc.content === undefined || doc.content.mediaType !== 'application/pdf')
    return fail('STATEMENT_NOT_UPLOADED_PDF', 'Only an uploaded PDF statement can be read');

  const file = await readBusinessDocument(tenant, applicationId, doc.content.sha256Hex, correlationId);
  if (file.kind !== 'BYTES')
    return fail(
      file.kind === 'TAMPERED' ? 'OBJECT_TAMPERED' : 'STORAGE_UNAVAILABLE',
      'The stored statement could not be read intact; nothing was read',
    );
  const engine = new NutrientDocumentExtraction(credentialProviderFromEnvironment(), {
    environment: 'sandbox',
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  });
  const extracted = await engine.extract({ tenantId: tenant, pdf: file.bytes, correlationId });
  if (!extracted.ok) return extracted;
  if (extracted.value.kind !== 'ANSWERED')
    return fail(
      'DOCUMENT_READING_UNAVAILABLE',
      'The document engine did not read the statement; nothing was proposed',
      {
        outcome: extracted.value.kind,
      },
    );

  const reading = readStatementFigures(extracted.value.value, policy.value);
  if (!reading.ok) return reading;
  if (reading.value.figures.length === 0)
    return fail('STATEMENT_NOTHING_READ', 'No figure could be read with confidence; key them from the statement', {
      skipped: String(reading.value.skipped.length),
    });
  return ingestReadFigures(
    tenant,
    applicationId,
    reading.value.figures.map((f) => ({
      metric: f.metric,
      periodLabel: f.periodLabel,
      minorUnits: f.minorUnits,
      sourceKind: 'OCR' as const,
      sourceRef: documentRef,
    })),
    READ_FIGURE_SOURCES.ocr,
  );
}
