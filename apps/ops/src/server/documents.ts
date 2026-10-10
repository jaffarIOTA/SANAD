/**
 * Documents for the workbench viewer.
 *
 * Development: the synthetic verification samples, by id, from the adapter's
 * samples directory. Production: the rendered artefacts the document platform
 * stores, fetched server-side through the adapter. The viewer's licence key is
 * read through the credential provider under its saved name; absent, the SDK
 * runs in its evaluation mode and the page says so.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CredentialNotConfiguredError } from '../../../../adapters/kernel/credentials-environment.ts';
import { credentialProviderFromEnvironment, credentialSource } from '@sanad/origination/credentials.ts';

/** Where the generated samples are: next to the adapter, from the app's working directory, unless set explicitly. */
const samplesDirectory = (): string =>
  process.env['SANAD_DOCUMENT_SAMPLES_DIR'] ??
  join(process.cwd(), '..', '..', 'adapters', 'nutrient', 'verification', 'samples');

export interface ViewerDocument {
  readonly documentId: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly fileName: string;
  readonly synthetic: true;
  /** Whose document it is: only that institution's staff may read it (SR-020). */
  readonly tenantId: string;
  /** The SHA-256 of the bytes as generated; anything else on disk is refused (SR-020). */
  readonly sha256: string;
}

export const VIEWER_DOCUMENTS: readonly ViewerDocument[] = [
  {
    documentId: 'sample-delivery-note',
    titleEn: 'Delivery note (synthetic)',
    titleAr: 'إشعار تسليم (نموذج اصطناعي)',
    fileName: 'synthetic-delivery-note.pdf',
    synthetic: true,
    tenantId: 'bank-a',
    sha256: 'c17b16feeaa7a4ee5d4a3b4863f53aa0380aae165b51dbb38caa9eb21cfe6aaa',
  },
  {
    documentId: 'sample-commercial-invoice',
    titleEn: 'Commercial invoice (synthetic)',
    titleAr: 'فاتورة تجارية (نموذج اصطناعي)',
    fileName: 'synthetic-commercial-invoice.pdf',
    synthetic: true,
    tenantId: 'bank-a',
    sha256: '3f2640bb1fa29fa9f7d4a44af04ec5285669cb96fd877dd82c47cbdb559ccfa7',
  },
  {
    documentId: 'sample-identity-page',
    titleEn: 'Identity page (synthetic)',
    titleAr: 'صفحة هوية (نموذج اصطناعي)',
    fileName: 'synthetic-identity-page.pdf',
    synthetic: true,
    tenantId: 'bank-a',
    sha256: '7385b2a5bf941499112ba4294f2f57e1387b0752d475530cd544e071dc022378',
  },
];

export function findViewerDocument(documentId: string): ViewerDocument | undefined {
  return VIEWER_DOCUMENTS.find((d) => d.documentId === documentId);
}

/** The sample's bytes, if generated: `MISSING` if not, `TAMPERED` if they are not the bytes the hash names. */
export function readSampleBytes(doc: ViewerDocument): Uint8Array | 'MISSING' | 'TAMPERED' {
  const path = join(samplesDirectory(), doc.fileName);
  if (!existsSync(path)) return 'MISSING';
  const bytes = new Uint8Array(readFileSync(path));
  return createHash('sha256').update(bytes).digest('hex') === doc.sha256 ? bytes : 'TAMPERED';
}

export interface ViewerLicence {
  readonly kind: 'LICENSED';
  readonly licenseKey: string;
  readonly source: 'VAULT' | 'ENVIRONMENT';
}
export interface ViewerEvaluation {
  readonly kind: 'EVALUATION';
  readonly source: 'VAULT' | 'ENVIRONMENT';
}

/**
 * The Web SDK licence key is domain-bound configuration handed to the browser;
 * it is still never committed. Read through whichever credential provider the
 * environment selects: the vault when a database is reachable, else the
 * development environment provider. A key not yet saved is evaluation mode.
 */
export async function viewerLicence(): Promise<ViewerLicence | ViewerEvaluation> {
  const source = credentialSource();
  try {
    const key = await credentialProviderFromEnvironment().get(
      { tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', keyName: 'web_sdk_license_key' },
      'viewer',
    );
    return { kind: 'LICENSED', licenseKey: key.expose(), source };
  } catch (error) {
    if (error instanceof CredentialNotConfiguredError) return { kind: 'EVALUATION', source };
    if (error instanceof Error && /no credential/.test(error.message)) return { kind: 'EVALUATION', source };
    throw error;
  }
}
