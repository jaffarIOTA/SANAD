/**
 * Declarative structure definitions.
 *
 * A structure is data: the legs, their order, the gates between them, the evidence
 * types that discharge each gate, and the minimum risk-holding interval. It is
 * bound to a Shariah approval record and versioned (SDD §6.5.1). Adding or
 * retuning a structure is a configuration and approval activity, not an engine
 * change — which is exactly what lets two Boards rule differently without a fork
 * (§3.11).
 *
 * The parser below is the one place where the config/code boundary is defended.
 * Because sequences are data, a malformed definition is a potential bypass, so a
 * tenant's definition may TIGHTEN the platform floor and may never loosen it: the
 * mandatory gates before a sale leg are asserted here, whatever the file says.
 */

import type { EvidenceType, GateId } from '@sanad/core/evidence/evidence.ts';
import type { LegType } from '../legs/leg.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

export type StructureCode = 'MURABAHA' | 'SALAM' | 'ISTISNA' | 'IJARAH' | 'MUSHARAKA';

export interface LegDefinition {
  readonly type: LegType;
  readonly seq: number;
  /** Template slug. Resolved to an approved template version at render time. */
  readonly document: string;
}

/** What a gate waits on: a leg having executed, or an earlier gate. */
export type GatePredecessor = { readonly leg: LegType } | { readonly gate: GateId };

export interface EvidenceGateDefinition {
  readonly id: GateId;
  readonly kind: 'EVIDENCE';
  readonly after: GatePredecessor;
  /** Any one of these types discharges the gate. The Board sets the list. */
  readonly requires: { readonly anyOf: readonly EvidenceType[] };
  /** Type-specific assertions the evidence payload must satisfy. */
  readonly validation?: Readonly<Record<string, string | number | boolean>>;
  /** Where set, self-attested artefacts cannot discharge this gate. */
  readonly requireThirdPartySource?: boolean;
  /**
   * Floor for machine-extracted artefacts, per ten thousand. Below it, the
   * artefact routes to operations rather than discharging the gate.
   */
  readonly minimumExtractionConfidencePerTenThousand?: number;
}

/**
 * When the interval starts, where more than one artefact discharged the
 * preceding gate. A Board can reasonably rule either way — possession became
 * true when the first qualifying artefact attests it, or not until the last —
 * so it is configuration, not a decision we make for them (§3.11).
 */
export type RiskPeriodStartBasis =
  | 'EARLIEST_DISCHARGING_EVIDENCE'
  | 'LATEST_DISCHARGING_EVIDENCE';

export interface ElapseGateDefinition {
  readonly id: GateId;
  readonly kind: 'ELAPSE';
  readonly after: GatePredecessor;
  /** Board-set. Snapshotted onto each transaction at inception. */
  readonly minimumSeconds: number;
  /** Only one admissible clock. Declared so the config states it explicitly. */
  readonly clock: 'TRUSTED_TIMESTAMP_AUTHORITY';
  /** Defaults to the later, more conservative, reading where unstated. */
  readonly startBasis?: RiskPeriodStartBasis;
}

export type GateDefinition = EvidenceGateDefinition | ElapseGateDefinition;

export interface StructureConstraints {
  /** Roles that must be distinct legal entities, matched on registration number. */
  readonly distinctParties: readonly (readonly [string, string])[];
  readonly oneDocumentPerLeg: true;
  readonly monotonicTimestamps: true;
}

export interface StructureDefinition {
  readonly definitionId: string;
  readonly structureCode: StructureCode;
  readonly version: number;
  /** The approval this definition executes under. No approval, no activation. */
  readonly shariahApprovalRef: string;
  readonly legs: readonly LegDefinition[];
  readonly gates: readonly GateDefinition[];
  readonly constraints: StructureConstraints;
}

/**
 * The platform floor. A Murabaha sale leg is unreachable until all three gates
 * are satisfied, whatever a tenant's definition file omits (SH-05, SH-06).
 */
export const MANDATORY_GATES_BEFORE_SALE: Readonly<Record<StructureCode, readonly GateId[]>> = {
  MURABAHA: ['GATE_1_OWNERSHIP', 'GATE_2_POSSESSION', 'GATE_3_RISK_PERIOD'],
  SALAM: [],
  ISTISNA: [],
  IJARAH: ['GATE_1_OWNERSHIP', 'GATE_2_POSSESSION'],
  MUSHARAKA: [],
};

/** A risk-holding interval of zero is not a risk-holding interval. */
export const MINIMUM_RISK_PERIOD_SECONDS = 1;

/**
 * Validate a definition loaded from configuration.
 *
 * Returns a rejection rather than throwing, so a bad tenant file surfaces as a
 * refusal to activate rather than a crash at drawdown time.
 */
export function parseStructureDefinition(input: unknown): Result<StructureDefinition> {
  const d = input as StructureDefinition;

  if (typeof d !== 'object' || d === null) {
    return reject('OP-DETERMINACY', 'DEFINITION_NOT_AN_OBJECT', 'Structure definition is not an object');
  }
  if (typeof d.shariahApprovalRef !== 'string' || d.shariahApprovalRef.length === 0) {
    return reject(
      'SH-17',
      'NO_SHARIAH_APPROVAL_REFERENCE',
      'A structure definition must name the approval it executes under',
      { definitionId: String(d.definitionId) },
    );
  }
  if (!Array.isArray(d.legs) || d.legs.length === 0) {
    return reject('OP-DETERMINACY', 'NO_LEGS', 'A structure must declare at least one leg');
  }

  // Leg sequence numbers must be unique and ordered.
  const seen = new Set<number>();
  let previousSeq = 0;
  for (const leg of d.legs) {
    if (seen.has(leg.seq)) {
      return reject('OP-DETERMINACY', 'DUPLICATE_LEG_SEQUENCE', 'Leg sequence numbers must be unique', {
        seq: leg.seq,
      });
    }
    if (leg.seq <= previousSeq) {
      return reject('OP-DETERMINACY', 'LEG_SEQUENCE_UNORDERED', 'Legs must be declared in sequence order', {
        seq: leg.seq,
      });
    }
    seen.add(leg.seq);
    previousSeq = leg.seq;
  }

  const gateIds = new Set(d.gates.map((g) => g.id));

  // The floor. A tenant may add gates; it may not remove one.
  const required = MANDATORY_GATES_BEFORE_SALE[d.structureCode] ?? [];
  const hasSaleLeg = d.legs.some((l) => l.type === 'SALE_OFFER');
  if (hasSaleLeg) {
    for (const gateId of required) {
      if (!gateIds.has(gateId)) {
        return reject(
          'SH-05',
          'MANDATORY_GATE_MISSING',
          `Structure declares a sale leg but omits ${gateId}; the platform floor cannot be loosened by configuration`,
          { definitionId: d.definitionId, gateId },
        );
      }
    }
  }

  for (const gate of d.gates) {
    if (gate.kind === 'ELAPSE') {
      if (gate.clock !== 'TRUSTED_TIMESTAMP_AUTHORITY') {
        return reject(
          'SH-06',
          'UNTRUSTED_CLOCK',
          'An elapse gate may only be measured against the timestamping authority',
          { gateId: gate.id },
        );
      }
      if (!Number.isInteger(gate.minimumSeconds) || gate.minimumSeconds < MINIMUM_RISK_PERIOD_SECONDS) {
        return reject(
          'SH-06',
          'RISK_PERIOD_NOT_POSITIVE',
          'The risk-holding interval must be a positive whole number of seconds',
          { gateId: gate.id, minimumSeconds: gate.minimumSeconds },
        );
      }
    } else if (gate.requires.anyOf.length === 0) {
      return reject(
        'SH-05',
        'GATE_ACCEPTS_NO_EVIDENCE',
        'An evidence gate must declare at least one admissible evidence type',
        { gateId: gate.id },
      );
    }

    // A gate cannot depend on a gate that is not declared.
    if ('gate' in gate.after && !gateIds.has(gate.after.gate)) {
      return reject('OP-DETERMINACY', 'GATE_PREDECESSOR_UNDECLARED', 'Gate depends on an undeclared gate', {
        gateId: gate.id,
        after: gate.after.gate,
      });
    }
  }

  if (d.constraints?.oneDocumentPerLeg !== true || d.constraints?.monotonicTimestamps !== true) {
    return reject(
      'SH-07',
      'STRUCTURAL_CONSTRAINT_DISABLED',
      'oneDocumentPerLeg and monotonicTimestamps are not optional',
      { definitionId: d.definitionId },
    );
  }

  return ok(d);
}

export function findGate(
  definition: StructureDefinition,
  gateId: GateId,
): GateDefinition | undefined {
  return definition.gates.find((g) => g.id === gateId);
}

/** The gates that must hold before the sale leg, in declared order. */
export function gatesBeforeSale(definition: StructureDefinition): readonly GateDefinition[] {
  const required = new Set(MANDATORY_GATES_BEFORE_SALE[definition.structureCode] ?? []);
  return definition.gates.filter((g) => required.has(g.id));
}
