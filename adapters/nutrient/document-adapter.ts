/**
 * Document platform adapter — Nutrient.
 *
 * Implements rendering, signing and document intelligence. See README.md in this
 * directory for deployment, verification status and known deviations.
 *
 * Two checks in here are the adapter enforcing something the vendor may only
 * enforce by convention, and they are the reason this file is not a thin
 * passthrough:
 *
 *   - a render whose merge fields are not a declared subset of the template
 *     version's fields is refused before the call is made, so a Board-approved
 *     locked clause cannot be substituted into (BR-G02);
 *   - extraction confidence is floored to an integer per ten thousand, rounding
 *     down, so a borderline extraction is treated as the weaker reading.
 */

import type {
  DocumentIntelligenceProvider,
  DocumentRenderingProvider,
  DriftReport,
  ExtractedField,
  ExtractionOutcome,
  IdentityAssertionRef,
  RedactionRule,
  RenderedDocument,
  SignatureValidation,
  SignedDocument,
  SigningProvider,
  TemplateVersion,
} from '../../core/ports/documents.ts';
import type { CredentialProvider } from '../../core/ports/credentials.ts';
import type { LegRenderRequest, RenderLocale } from '../../core/documents/render.ts';
import type { VerifiedTimestamp } from '../../core/time/tsa.ts';
import { type Result, ok, reject } from '../../core/kernel/result.ts';
import { type AdapterConfig, BaseAdapter, type KnownDeviation } from '../kernel/adapter.ts';
import { CircuitOpenError } from '../kernel/circuit-breaker.ts';

export type NutrientOperation =
  | 'template.resolve'
  | 'document.render'
  | 'document.compare'
  | 'document.archive'
  | 'signature.padesLtv'
  | 'signature.seal'
  | 'signature.validate'
  | 'intelligence.extract'
  | 'intelligence.redact';

export interface NutrientTransport {
  call(
    operation: NutrientOperation,
    payload: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, unknown>>>;
}

/** Exported for the architecture suite. See the Tuum adapter for the rationale. */
export const NUTRIENT_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'NUTR-DEV-001',
    summary: 'Extraction confidence is conventionally a floating point score in [0,1].',
    containment:
      'Converted at the boundary to an integer per ten thousand, rounding down, so a borderline extraction is treated as the weaker reading and routes to operations rather than discharging a gate.',
    verificationRef: 'OI-05',
  },
  {
    id: 'NUTR-DEV-002',
    summary:
      'Locked template regions may be a template convention rather than an API-enforced guarantee.',
    containment:
      'The adapter refuses any render whose merge fields are not a subset of the template version’s declared fields, before the call is made.',
    verificationRef: 'OI-05',
  },
];

export class NutrientDocumentAdapter
  extends BaseAdapter
  implements DocumentRenderingProvider, SigningProvider, DocumentIntelligenceProvider
{
  // One product satisfying three capabilities. An institution may well split
  // them across three, which is why they are three interfaces.
  readonly capabilities = ['DOCUMENT_RENDERING', 'SIGNING', 'DOCUMENT_INTELLIGENCE'] as const;
  readonly vendorName = 'Nutrient';
  readonly deviations = NUTRIENT_DEVIATIONS;

  constructor(
    config: AdapterConfig,
    credentials: CredentialProvider,
    private readonly transport: NutrientTransport,
  ) {
    super(config, credentials);
  }

  // -- Rendering --------------------------------------------------------------

  async resolveTemplateVersion(
    tenantId: string,
    templateId: string,
    version: number,
  ): Promise<Result<TemplateVersion>> {
    if (!Number.isInteger(version) || version <= 0) {
      return reject(
        'SH-17',
        'TEMPLATE_VERSION_NOT_EXPLICIT',
        'Rendering is always against an explicit approved version, never "latest"',
        { templateId },
      );
    }
    const response = await this.#invoke('template.resolve', tenantId, { templateId, version });
    if (!response.ok) return response;

    const body = response.value;
    const templateVersionId = body['templateVersionId'];
    const shariahApprovalRef = body['shariahApprovalRef'];
    if (typeof templateVersionId !== 'string' || typeof shariahApprovalRef !== 'string') {
      return reject(
        'SH-17',
        'TEMPLATE_METADATA_INCOMPLETE',
        'A template version must carry the approval reference it was approved under',
        { templateId },
      );
    }

    return ok({
      templateVersionId,
      templateId,
      version,
      lockedRegionIds: stringArray(body['lockedRegionIds']),
      mergeFieldNames: stringArray(body['mergeFieldNames']),
      shariahApprovalRef,
    });
  }

  /**
   * Render one leg into one document.
   *
   * `LegRenderRequest` holds a single leg, so there is no combined-rendering
   * path to close off here — the type closed it (SH-07).
   */
  async render(request: LegRenderRequest): Promise<Result<RenderedDocument>> {
    const template = await this.resolveTemplateVersionById(
      request.tenantId,
      request.templateVersionId,
    );
    if (!template.ok) return template;

    // NUTR-DEV-002. Enforced here rather than trusted to the engine.
    const declared = new Set(template.value.mergeFieldNames);
    const undeclared = Object.keys(request.mergeFields).filter((f) => !declared.has(f));
    if (undeclared.length > 0) {
      return reject(
        'SH-07',
        'UNDECLARED_MERGE_FIELD',
        'A render may only substitute into fields the approved template declares; Board-approved clauses are not substitutable',
        { templateVersionId: request.templateVersionId, undeclared: undeclared.join(',') },
      );
    }

    const response = await this.#invoke(
      'document.render',
      request.tenantId,
      {
        templateVersionId: request.templateVersionId,
        legId: request.leg.legId,
        legType: request.leg.legType,
        governingLocale: request.governingLocale,
        translationLocale: request.translationLocale,
        mergeFields: request.mergeFields,
        shariahApprovalId: request.shariahApprovalId,
      },
      request.correlationId,
    );
    if (!response.ok) return response;

    const body = response.value;
    const documentId = body['documentId'];
    const contentHash = body['contentHash'];
    const artefactUri = body['artefactUri'];
    if (
      typeof documentId !== 'string' ||
      typeof contentHash !== 'string' ||
      typeof artefactUri !== 'string'
    ) {
      return reject('OP-CHAIN', 'RENDER_RESPONSE_MALFORMED', 'The render response was not understood');
    }

    return ok({
      documentId,
      contentHash,
      artefactUri,
      templateVersionId: request.templateVersionId,
      pageCount: numberOr(body['pageCount'], 0),
      sizeBytes: numberOr(body['sizeBytes'], 0),
    });
  }

  async compareToTemplate(documentId: string, templateVersionId: string): Promise<Result<DriftReport>> {
    const response = await this.#invoke('document.compare', this.config.tenantId, {
      documentId,
      templateVersionId,
    });
    if (!response.ok) return response;

    const altered = stringArray(response.value['alteredLockedRegionIds']);
    return ok({
      documentId,
      templateVersionId,
      hasDrift: altered.length > 0 || response.value['hasDrift'] === true,
      alteredLockedRegionIds: altered,
      summary: typeof response.value['summary'] === 'string' ? response.value['summary'] : '',
    });
  }

  async archive(
    documentId: string,
    retentionYears: number,
  ): Promise<Result<{ readonly archiveUri: string }>> {
    const response = await this.#invoke('document.archive', this.config.tenantId, {
      documentId,
      retentionYears,
      format: 'LONG_TERM_PRESERVATION',
      embedValidationMaterial: true,
    });
    if (!response.ok) return response;
    const archiveUri = response.value['archiveUri'];
    if (typeof archiveUri !== 'string') {
      return reject('OP-DETERMINACY', 'ARCHIVE_URI_MISSING', 'The archive response carried no location');
    }
    return ok({ archiveUri });
  }

  // -- Signature --------------------------------------------------------------

  async signMasterAgreement(params: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly contentHash: string;
    readonly signatoryAssertion: IdentityAssertionRef;
    readonly correlationId: string;
  }): Promise<Result<SignedDocument>> {
    return this.#sign('signature.padesLtv', 'PADES_LTV', params);
  }

  async sealLeg(params: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly contentHash: string;
    readonly signatoryAssertion: IdentityAssertionRef;
    readonly correlationId: string;
  }): Promise<Result<SignedDocument>> {
    return this.#sign('signature.seal', 'INSTITUTIONAL_SEAL', params);
  }

  async validate(documentId: string): Promise<Result<SignatureValidation>> {
    const response = await this.#invoke('signature.validate', this.config.tenantId, { documentId });
    if (!response.ok) return response;
    const body = response.value;
    return ok({
      documentId,
      signatureValid: body['signatureValid'] === true,
      certificateChainValid: body['certificateChainValid'] === true,
      timestampValid: body['timestampValid'] === true,
      longTermValidationPresent: body['longTermValidationPresent'] === true,
      validatedAgainstEpochSeconds: BigInt(numberOr(body['validatedAtEpochSeconds'], 0)),
    });
  }

  // -- Document intelligence --------------------------------------------------

  async extract(params: {
    readonly tenantId: string;
    readonly artefactUri: string;
    readonly expectedDocumentClass: string;
    readonly locales: readonly RenderLocale[];
    readonly correlationId: string;
  }): Promise<Result<ExtractionOutcome>> {
    const response = await this.#invoke(
      'intelligence.extract',
      params.tenantId,
      {
        artefactUri: params.artefactUri,
        expectedDocumentClass: params.expectedDocumentClass,
        locales: [...params.locales],
      },
      params.correlationId,
    );
    if (!response.ok) return response;

    const raw = response.value['fields'];
    if (!Array.isArray(raw)) {
      return reject('OP-DETERMINACY', 'EXTRACTION_MALFORMED', 'The extraction response was not understood');
    }

    const fields: ExtractedField[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const name = e['name'];
      const value = e['value'];
      if (typeof name !== 'string' || typeof value !== 'string') continue;
      fields.push({
        name,
        value,
        // NUTR-DEV-001. Floor, never round to nearest.
        confidencePerTenThousand: toPerTenThousand(e['confidence']),
      });
    }

    const lowest = fields.reduce(
      (min, f) => (f.confidencePerTenThousand < min ? f.confidencePerTenThousand : min),
      10000,
    );

    return ok({
      artefactUri: params.artefactUri,
      documentClass:
        typeof response.value['documentClass'] === 'string'
          ? response.value['documentClass']
          : params.expectedDocumentClass,
      fields,
      lowestConfidencePerTenThousand: fields.length === 0 ? 0 : lowest,
    });
  }

  async redact(params: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly rules: readonly RedactionRule[];
    readonly recipientClass: RedactionRule['recipientClass'];
    readonly correlationId: string;
  }): Promise<Result<{ readonly redactedDocumentId: string; readonly artefactUri: string }>> {
    const applicable = params.rules.filter((r) => r.recipientClass === params.recipientClass);
    if (applicable.length === 0) {
      return reject(
        'OP-DETERMINACY',
        'NO_REDACTION_RULES',
        'Disclosure outside the institution requires an explicit redaction rule set; an empty set is not a decision to disclose everything',
        { recipientClass: params.recipientClass },
      );
    }

    const response = await this.#invoke(
      'intelligence.redact',
      params.tenantId,
      {
        documentId: params.documentId,
        recipientClass: params.recipientClass,
        fieldNames: applicable.map((r) => r.fieldName).sort((a, b) => a.localeCompare(b)),
      },
      params.correlationId,
    );
    if (!response.ok) return response;

    const redactedDocumentId = response.value['redactedDocumentId'];
    const artefactUri = response.value['artefactUri'];
    if (typeof redactedDocumentId !== 'string' || typeof artefactUri !== 'string') {
      return reject('OP-DETERMINACY', 'REDACTION_MALFORMED', 'The redaction response was not understood');
    }
    return ok({ redactedDocumentId, artefactUri });
  }

  // ---------------------------------------------------------------------------

  private async resolveTemplateVersionById(
    tenantId: string,
    templateVersionId: string,
  ): Promise<Result<TemplateVersion>> {
    const response = await this.#invoke('template.resolve', tenantId, { templateVersionId });
    if (!response.ok) return response;
    const body = response.value;
    const shariahApprovalRef = body['shariahApprovalRef'];
    if (typeof shariahApprovalRef !== 'string') {
      return reject(
        'SH-17',
        'TEMPLATE_METADATA_INCOMPLETE',
        'A template version must carry its approval reference',
        { templateVersionId },
      );
    }
    return ok({
      templateVersionId,
      templateId: typeof body['templateId'] === 'string' ? body['templateId'] : '',
      version: numberOr(body['version'], 0),
      lockedRegionIds: stringArray(body['lockedRegionIds']),
      mergeFieldNames: stringArray(body['mergeFieldNames']),
      shariahApprovalRef,
    });
  }

  async #sign(
    operation: 'signature.padesLtv' | 'signature.seal',
    profile: SignedDocument['profile'],
    params: {
      readonly tenantId: string;
      readonly documentId: string;
      readonly contentHash: string;
      readonly signatoryAssertion: IdentityAssertionRef;
      readonly correlationId: string;
    },
  ): Promise<Result<SignedDocument>> {
    const response = await this.#invoke(
      operation,
      params.tenantId,
      {
        documentId: params.documentId,
        // The hash of the exact rendition presented. What is signed is what was seen.
        contentHash: params.contentHash,
        identityAssertionId: params.signatoryAssertion.value,
        requestTimestamp: true,
      },
      params.correlationId,
    );
    if (!response.ok) return response;

    const body = response.value;
    const signatureId = body['signatureId'];
    const signedHash = body['contentHash'];
    if (typeof signatureId !== 'string' || typeof signedHash !== 'string') {
      return reject('OP-CHAIN', 'SIGNATURE_RESPONSE_MALFORMED', 'The signing response was not understood');
    }
    if (signedHash !== params.contentHash) {
      return reject(
        'OP-CHAIN',
        'SIGNED_RENDITION_DIFFERS',
        'The rendition that was signed is not the rendition that was presented',
        { documentId: params.documentId },
      );
    }

    const timestamp = readTimestamp(body['timestamp']);
    if (timestamp === undefined) {
      // Compliance dependencies never degrade. No leg executes without one.
      return reject(
        'SH-06',
        'NO_TRUSTED_TIMESTAMP',
        'The signature carried no verifiable timestamp; the leg does not execute',
        { documentId: params.documentId },
      );
    }

    return ok({ documentId: params.documentId, signatureId, contentHash: signedHash, timestamp, profile });
  }

  async #invoke(
    operation: NutrientOperation,
    tenantId: string,
    payload: Readonly<Record<string, unknown>>,
    correlationId = '',
  ): Promise<Result<Readonly<Record<string, unknown>>>> {
    try {
      const apiKey = await this.credential('api_key', correlationId);
      const body = await this.breaker.execute(() =>
        this.transport.call(
          operation,
          { ...payload, tenantReference: tenantId },
          {
            Authorization: `Bearer ${apiKey.expose()}`,
            ...(correlationId === '' ? {} : { 'X-Correlation-Id': correlationId }),
          },
        ),
      );
      return ok(body);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return reject(
          'OP-DETERMINACY',
          'DOCUMENT_PLATFORM_CIRCUIT_OPEN',
          'The document platform is unavailable; generation is queued and will resume automatically',
          { operation },
        );
      }
      return reject(
        'OP-DETERMINACY',
        'DOCUMENT_PLATFORM_CALL_FAILED',
        'The document platform did not complete the request',
        { operation },
      );
    }
  }
}

// -----------------------------------------------------------------------------

/** Floor a [0,1] score to an integer per ten thousand. Never rounds up. */
function toPerTenThousand(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 10000;
  return Math.floor(value * 10000);
}

function readTimestamp(value: unknown): VerifiedTimestamp | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const t = value as Record<string, unknown>;
  const genTime = t['genTimeEpochSeconds'];
  const tokenDigest = t['tokenDigest'];
  const authorityId = t['authorityId'];
  if (t['verified'] !== true) return undefined;
  if (typeof tokenDigest !== 'string' || typeof authorityId !== 'string') return undefined;
  if (typeof genTime !== 'number' && typeof genTime !== 'string') return undefined;
  return {
    verified: true,
    genTimeEpochSeconds: BigInt(genTime),
    tokenDigest,
    authorityId,
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
