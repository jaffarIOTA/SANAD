/**
 * The live transport to a self-hosted Document Engine.
 *
 * One table maps each adapter operation to an HTTP envelope. Every row is an
 * assumption about the engine's API until the verification check named beside
 * it has run (adapters/nutrient/verification/README.md); a row that proves
 * wrong changes here, and the adapter above does not notice.
 *
 * Egress is through the kernel's HttpTransport with an injected fetch, so the
 * institution's forward proxy is honoured by whoever composes this, not by
 * this file. The base URL is configuration from the credential store
 * (`document_engine_base_url`); the token arrives in the headers the adapter
 * built and is never read here.
 */

import { type HttpTransport, type RailEnvelope, TransportError } from '../kernel/http-transport.ts';

import type { NutrientOperation, NutrientTransport } from './document-adapter.ts';

type Payload = Readonly<Record<string, unknown>>;

interface Route {
  readonly method: RailEnvelope['method'];
  readonly path: (p: Payload) => string;
  readonly body?: (p: Payload) => Payload | undefined;
  /** The check that confirms or corrects this row. */
  readonly verification: 'V-02' | 'V-03' | 'V-04' | 'V-05' | 'V-06' | 'V-08';
}

const str = (p: Payload, k: string): string => {
  const v = p[k];
  if (typeof v !== 'string' || v.length === 0) throw new TransportError('envelope', undefined, `missing ${k}`);
  return encodeURIComponent(v);
};

export const DOCUMENT_ENGINE_ROUTES: Readonly<Record<NutrientOperation, Route>> = {
  'template.resolve': { method: 'GET', path: (p) => `/api/documents/${str(p, p['templateVersionId'] !== undefined ? 'templateVersionId' : 'templateId')}/properties`, verification: 'V-05' },
  'document.render': { method: 'POST', path: () => '/api/build', body: (p) => ({ parts: [{ document: { id: p['templateVersionId'] } }], actions: [{ type: 'fillForm', fields: p['mergeFields'] }, { type: 'flatten' }], output: { type: 'pdf' } }), verification: 'V-05' },
  'document.compare': { method: 'GET', path: (p) => `/api/documents/${str(p, 'documentId')}/form-field-values`, verification: 'V-05' },
  'document.archive': { method: 'POST', path: (p) => `/api/documents/${str(p, 'documentId')}/pdfa`, body: (p) => ({ conformance: 'pdfa-2b', embedValidationMaterial: p['embedValidationMaterial'] === true }), verification: 'V-04' },
  'signature.padesLtv': { method: 'POST', path: (p) => `/api/documents/${str(p, 'documentId')}/sign`, body: (p) => ({ signatureType: 'cades', cadesLevel: 'b-lt', flatten: true, signatureMetadata: { signerName: 'institution', signatureReason: p['identityAssertionId'] } }), verification: 'V-04' },
  'signature.seal': { method: 'POST', path: (p) => `/api/documents/${str(p, 'documentId')}/sign`, body: (p) => ({ signatureType: 'cades', cadesLevel: 'b-t', flatten: true, signatureMetadata: { signerName: 'institution', signatureReason: p['identityAssertionId'] } }), verification: 'V-04' },
  'signature.validate': { method: 'GET', path: (p) => `/api/documents/${str(p, 'documentId')}/digital_signatures`, verification: 'V-04' },
  'intelligence.extract': { method: 'POST', path: () => '/api/process', body: (p) => ({ artefactUri: p['artefactUri'], expectedDocumentClass: p['expectedDocumentClass'], locales: p['locales'] }), verification: 'V-06' },
  'intelligence.redact': { method: 'POST', path: (p) => `/api/documents/${str(p, 'documentId')}/redactions`, body: (p) => ({ strategy: 'preset', strategyOptions: { fieldNames: p['fieldNames'] }, apply: true }), verification: 'V-08' },
};

export class DocumentEngineTransport implements NutrientTransport {
  constructor(
    private readonly http: HttpTransport,
    /** From the credential store; never a vendor-hosted host in a deployed environment. */
    private readonly baseUrl: string,
  ) {
    if (!/^https?:\/\/[^/\s]+$/.test(baseUrl)) throw new TypeError('document engine base URL is scheme and host only, no trailing slash or path');
  }

  call(operation: NutrientOperation, payload: Payload, headers: Readonly<Record<string, string>>): Promise<Readonly<Record<string, unknown>>> {
    const route = DOCUMENT_ENGINE_ROUTES[operation];
    const body = route.body?.(payload);
    return this.http.call(operation, { method: route.method, url: `${this.baseUrl}${route.path(payload)}`, headers, ...(body === undefined ? {} : { body }) });
  }
}
