/**
 * Document, signature and document-intelligence ports.
 *
 * Three capabilities, three interfaces, because an institution may well satisfy
 * them with three products. They are grouped in one file because they share
 * types, not because they are one vendor.
 *
 * The residency position depends on the implementation being deployed inside the
 * same trust boundary as the application rather than consumed as an external
 * service: contract documents carry national identifiers, commercial terms and
 * signatures, and none of that may leave the Kingdom (NFR-05, RC-03, SDD §4.8).
 */

import type { Result } from '../kernel/result.ts';
import type { LegRenderRequest, RenderLocale } from '../documents/render.ts';
import type { VerifiedTimestamp } from '../time/tsa.ts';

export interface DocumentRef {
  readonly value: string;
}

export interface RenderedDocument {
  readonly documentId: string;
  /** Hash of the exact rendition. What is signed is what was seen (BR-G06). */
  readonly contentHash: string;
  readonly artefactUri: string;
  readonly templateVersionId: string;
  readonly pageCount: number;
  readonly sizeBytes: number;
}

export interface TemplateVersion {
  readonly templateVersionId: string;
  readonly templateId: string;
  readonly version: number;
  /** Board-approved clauses. The render path cannot substitute into these. */
  readonly lockedRegionIds: readonly string[];
  /** The only fields a render may fill. */
  readonly mergeFieldNames: readonly string[];
  readonly shariahApprovalRef: string;
}

export interface DriftReport {
  readonly documentId: string;
  readonly templateVersionId: string;
  readonly hasDrift: boolean;
  /** Locked regions that differ from the approved template. */
  readonly alteredLockedRegionIds: readonly string[];
  readonly summary: string;
}

/**
 * Rendering and template control.
 *
 * `render` takes a `LegRenderRequest`, which holds exactly one leg. There is no
 * batch variant that accepts several legs for one output file — batching means
 * many documents generated concurrently, never many legs in one instrument
 * (SH-07).
 */
export interface DocumentRenderingProvider {
  resolveTemplateVersion(
    tenantId: string,
    templateId: string,
    /** Explicit. Never "latest". */
    version: number,
  ): Promise<Result<TemplateVersion>>;

  render(request: LegRenderRequest): Promise<Result<RenderedDocument>>;

  /** Compare an executed document against the version it claims (BR-F07). */
  compareToTemplate(
    documentId: string,
    templateVersionId: string,
  ): Promise<Result<DriftReport>>;

  /** Long-term preservation format with validation material embedded (BR-G10). */
  archive(documentId: string, retentionYears: number): Promise<Result<{ readonly archiveUri: string }>>;
}

// -- Signature ----------------------------------------------------------------

export interface IdentityAssertionRef {
  readonly value: string;
}

export interface SignedDocument {
  readonly documentId: string;
  readonly signatureId: string;
  /** Hash of the signed rendition — must equal the presented rendition's hash. */
  readonly contentHash: string;
  readonly timestamp: VerifiedTimestamp;
  readonly profile: 'PADES_LTV' | 'INSTITUTIONAL_SEAL';
}

export interface SignatureValidation {
  readonly documentId: string;
  readonly signatureValid: boolean;
  readonly certificateChainValid: boolean;
  readonly timestampValid: boolean;
  readonly longTermValidationPresent: boolean;
  readonly validatedAgainstEpochSeconds: bigint;
}

export interface SigningProvider {
  /**
   * Master agreement: full PAdES with long-term validation, on a certificate
   * from a licensed national certification service provider (BR-G04).
   */
  signMasterAgreement(params: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly contentHash: string;
    readonly signatoryAssertion: IdentityAssertionRef;
    readonly correlationId: string;
  }): Promise<Result<SignedDocument>>;

  /**
   * Per-transaction leg: electronic acceptance bound to a verified identity
   * assertion, sealed with the institution's own certificate (BR-G05).
   *
   * Whether this constitutes valid execution of a separate contract is OI-04 and
   * is a Board ruling, not an engineering decision. The two-tier model is
   * configuration: an institution whose Board requires full ceremonial execution
   * of every leg uses `signMasterAgreement` per leg instead.
   */
  sealLeg(params: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly contentHash: string;
    readonly signatoryAssertion: IdentityAssertionRef;
    readonly correlationId: string;
  }): Promise<Result<SignedDocument>>;

  validate(documentId: string): Promise<Result<SignatureValidation>>;
}

// -- Document intelligence ----------------------------------------------------

export interface ExtractedField {
  readonly name: string;
  readonly value: string;
  /** Per ten thousand, so confidence never becomes a floating point comparison. */
  readonly confidencePerTenThousand: number;
}

export interface ExtractionOutcome {
  readonly artefactUri: string;
  readonly documentClass: string;
  readonly fields: readonly ExtractedField[];
  /** Lowest field confidence. Compared against the gate's declared floor. */
  readonly lowestConfidencePerTenThousand: number;
}

export interface RedactionRule {
  readonly fieldName: string;
  readonly recipientClass: 'GUARANTOR' | 'TAKAFUL_OPERATOR' | 'EXTERNAL_COUNSEL' | 'REGULATOR';
}

/**
 * Extraction and redaction over uploaded, unstructured evidence — delivery
 * notes, warehouse receipts, transport documents.
 *
 * Extraction output is evidence with a confidence score, never a fact. Below the
 * gate's configured floor it routes to an operations queue; it does not quietly
 * discharge a gate (BR-G08, SDD §6.8).
 */
export interface DocumentIntelligenceProvider {
  extract(params: {
    readonly tenantId: string;
    readonly artefactUri: string;
    readonly expectedDocumentClass: string;
    readonly locales: readonly RenderLocale[];
    readonly correlationId: string;
  }): Promise<Result<ExtractionOutcome>>;

  /** Applied before any disclosure outside the institution (BR-G09). */
  redact(params: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly rules: readonly RedactionRule[];
    readonly recipientClass: RedactionRule['recipientClass'];
    readonly correlationId: string;
  }): Promise<Result<{ readonly redactedDocumentId: string; readonly artefactUri: string }>>;
}

export type { DocumentRef as DocumentReference };
