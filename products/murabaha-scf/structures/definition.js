 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }

















import { ok, reject } from '../../../core/kernel/result.js';

 






































































/**
 * The platform floor. A Murabaha sale leg is unreachable until all three gates
 * are satisfied, whatever a tenant's definition file omits (SH-05, SH-06).
 */
export const MANDATORY_GATES_BEFORE_SALE = {
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
export function parseStructureDefinition(input) {
  const d = input ;

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
  const seen = new Set();
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
  const required = _nullishCoalesce(MANDATORY_GATES_BEFORE_SALE[d.structureCode], () => ( []));
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

  if (_optionalChain([d, 'access', _ => _.constraints, 'optionalAccess', _2 => _2.oneDocumentPerLeg]) !== true || _optionalChain([d, 'access', _3 => _3.constraints, 'optionalAccess', _4 => _4.monotonicTimestamps]) !== true) {
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
  definition,
  gateId,
) {
  return definition.gates.find((g) => g.id === gateId);
}

/** The gates that must hold before the sale leg, in declared order. */
export function gatesBeforeSale(definition) {
  const required = new Set(_nullishCoalesce(MANDATORY_GATES_BEFORE_SALE[definition.structureCode], () => ( [])));
  return definition.gates.filter((g) => required.has(g.id));
}
