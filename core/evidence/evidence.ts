/**
 * Typed evidence.
 *
 * A checkbox is not evidence. Each gate requires an artefact of a declared type
 * with declared validation, and a document of the wrong type does not satisfy the
 * gate (SDD §3.5.3). Third-party sources outrank self-attestation, because the
 * point of the evidence chain is that the Board can verify the trade rather than
 * take the institution's word for it.
 *
 * Evidence is append-only. Corrections supersede; nothing is updated or deleted
 * (DP-03).
 */

import type { TsaInstant } from '../time/tsa.ts';

export type EvidenceType =
  | 'OWNERSHIP_INVOICE' // cleared e-invoice naming the institution as recipient
  | 'TITLE_RECORD' // registry record where the goods class has one
  | 'DELIVERY_NOTE'
  | 'WAREHOUSE_RECEIPT'
  | 'CONSTRUCTIVE_POSSESSION' // qabd hukmi — admissible only where the Board allows it
  | 'IDENTITY_ASSERTION'
  | 'SETTLEMENT_CONFIRMATION';

/**
 * Where the evidence came from. Ranked: a tax-authority-cleared invoice is worth
 * more than an upload, and the Board's view of a transaction shows which is which.
 */
export type EvidenceSource =
  | 'E_INVOICING_AUTHORITY'
  | 'BUSINESS_REGISTRY'
  | 'ANCHOR_SYSTEM'
  | 'PARTNER'
  | 'DOCUMENT_INTELLIGENCE' // extracted from an artefact, carries a confidence score
  | 'UPLOAD'; // self-attested; ranks lowest

/** Third-party attested sources rank above anything the counterparty supplies. */
export const THIRD_PARTY_SOURCES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>([
  'E_INVOICING_AUTHORITY',
  'BUSINESS_REGISTRY',
  'PARTNER',
]);

export const isThirdParty = (source: EvidenceSource): boolean => THIRD_PARTY_SOURCES.has(source);

export type ValidationStatus = 'VALID' | 'INVALID' | 'PENDING';

export type GateId = 'GATE_1_OWNERSHIP' | 'GATE_2_POSSESSION' | 'GATE_3_RISK_PERIOD';

export interface EvidenceRecord {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly transactionId: string;
  readonly legId?: string;

  readonly evidenceType: EvidenceType;
  /** Which gate this artefact is offered against. */
  readonly gateSatisfied: GateId;
  readonly source: EvidenceSource;

  /** Object-store reference under write-once retention, plus an integrity hash. */
  readonly artefactUri: string;
  readonly artefactHash: string;

  /** When the fact became true, attested — not when the row was written. */
  readonly capturedAt: TsaInstant;

  readonly validationStatus: ValidationStatus;
  /** Type-specific validation output. Structured, never free text. */
  readonly validationDetail?: Readonly<Record<string, string | number | boolean>>;

  /**
   * Confidence, where the artefact was machine-extracted, as an integer per ten
   * thousand. Below the configured floor the evidence routes to an operations
   * queue rather than being accepted silently (BR-G08).
   *
   * An integer rather than a fraction so that comparing it is never a floating
   * point comparison, and so the boundary rounds down rather than to nearest.
   */
  readonly extractionConfidencePerTenThousand?: number;

  /** Corrections supersede. The superseded row is retained. */
  readonly supersededBy?: string;
}

/** Only live, valid evidence can discharge a gate. */
export function isLive(e: EvidenceRecord): boolean {
  return e.supersededBy === undefined && e.validationStatus === 'VALID';
}

export function liveEvidenceForGate(
  evidence: readonly EvidenceRecord[],
  gate: GateId,
): readonly EvidenceRecord[] {
  return evidence.filter((e) => isLive(e) && e.gateSatisfied === gate);
}

/**
 * The earliest attested instant among a set of evidence. Gate 3 measures the
 * risk-holding interval from possession, so it needs the moment possession
 * actually became true, not the moment the last artefact happened to arrive.
 */
export function earliestCapturedAt(
  evidence: readonly EvidenceRecord[],
): TsaInstant | undefined {
  let earliest: TsaInstant | undefined;
  for (const e of evidence) {
    if (earliest === undefined || e.capturedAt.epochSeconds < earliest.epochSeconds) {
      earliest = e.capturedAt;
    }
  }
  return earliest;
}
