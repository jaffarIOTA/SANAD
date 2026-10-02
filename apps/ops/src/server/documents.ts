/**
 * Documents for the workbench viewer.
 *
 * Development: the synthetic verification samples, by id, from the adapter's
 * samples directory. Production: the rendered artefacts the document platform
 * stores, fetched server-side through the adapter. The viewer's licence key is
 * read through the credential provider under its saved name; absent, the SDK
 * runs in its evaluation mode and the page says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CredentialNotConfiguredError, EnvironmentCredentialProvider } from '@sanad/adapters/kernel/credentials-environment.ts';

const SAMPLES = join(process.cwd(), '..', '..', 'adapters', 'nutrient', 'verification', 'samples');

export interface ViewerDocument {
  readonly documentId: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly fileName: string;
  readonly synthetic: true;
}

export const VIEWER_DOCUMENTS: readonly ViewerDocument[] = [
  { documentId: 'sample-delivery-note', titleEn: 'Delivery note (synthetic)', titleAr: 'إشعار تسليم (نموذج اصطناعي)', fileName: 'synthetic-delivery-note.pdf', synthetic: true },
  { documentId: 'sample-commercial-invoice', titleEn: 'Commercial invoice (synthetic)', titleAr: 'فاتورة تجارية (نموذج اصطناعي)', fileName: 'synthetic-commercial-invoice.pdf', synthetic: true },
  { documentId: 'sample-identity-page', titleEn: 'Identity page (synthetic)', titleAr: 'صفحة هوية (نموذج اصطناعي)', fileName: 'synthetic-identity-page.pdf', synthetic: true },
];

export function findViewerDocument(documentId: string): ViewerDocument | undefined {
  return VIEWER_DOCUMENTS.find((d) => d.documentId === documentId);
}

export function readSampleBytes(doc: ViewerDocument): Uint8Array | undefined {
  const path = join(SAMPLES, doc.fileName);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
}

export interface ViewerLicence { readonly kind: 'LICENSED'; readonly licenseKey: string }
export interface ViewerEvaluation { readonly kind: 'EVALUATION' }

/** The Web SDK licence key is domain-bound configuration handed to the browser; it is still never committed. */
export async function viewerLicence(): Promise<ViewerLicence | ViewerEvaluation> {
  if (process.env['NODE_ENV'] === 'production') return { kind: 'EVALUATION' }; // the vault provider is wired here when the database is
  const provider = new EnvironmentCredentialProvider(() => undefined);
  try {
    const key = await provider.get({ tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', keyName: 'web_sdk_license_key' }, 'viewer');
    return { kind: 'LICENSED', licenseKey: key.expose() };
  } catch (error) {
    if (error instanceof CredentialNotConfiguredError) return { kind: 'EVALUATION' };
    throw error;
  }
}
