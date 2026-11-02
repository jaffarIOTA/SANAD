/**
 * Continuous Shariah compliance checks on a Murabaha transaction (BR-F03,
 * BR-F07): re-verified from the transaction's own record, independently of
 * the path that moved it, so a defect the sequencing engine should have
 * refused — or a record changed since — is found and raised as an incident.
 *
 *   SEQUENCE_INTEGRITY         the legs chain, their timestamps rise, they are
 *                              the structure's legs in its order, and the
 *                              state does not run ahead of them (SH-05, SH-07)
 *   EVIDENCE_COMPLETENESS      each gate the transaction is past is evidenced,
 *                              and every gate held when the sale was offered
 *   RISK_PERIOD                the goods were held at the institution's risk
 *                              for the interval before the sale offer (SH-06)
 *   COUNTERPARTY_DISTINCTNESS  seller, buyer and institution are three parties,
 *                              and the buyer is the same on every leg (SH-08)
 *   GOODS_PERMISSIBILITY       the goods were permissible under the register
 *                              in force at opening, and still are (SH-11)
 *   DISCLOSURE_ACCURACY        the sale price is the cost plus the profit (SH-15)
 *   TEMPLATE_DRIFT             each leg's template is one its approval covers,
 *                              and its document is what that template makes
 *                              of the transaction's figures (BR-F07, SH-17)
 *
 * Each finding carries the severity the check raises it at; a reviewer
 * re-rates it at triage. Pure: the host supplies the record, the
 * configuration as it stood, and each leg's document rebuilt from its
 * template; no clock is read.
 */

import type { EvidenceRecord } from '@sanad/core/evidence/evidence.ts';
import type { IncidentSeverity } from '@sanad/core/shariah/incidents.ts';
import { type TsaInstant, isStrictlyLater } from '@sanad/core/time/tsa.ts';

import { type ContractLeg, type LegType, verifyChain } from '../legs/leg.ts';
import { evaluateGates } from '../sequencing/gates.ts';
import type { Transaction } from '../sequencing/state.ts';
import { type BoardPositions, type InvoiceLineGoods, screenGoods } from '../structures/board-positions.ts';
import type { StructureDefinition } from '../structures/definition.ts';

export type CheckCode =
  | 'SEQUENCE_INTEGRITY'
  | 'EVIDENCE_COMPLETENESS'
  | 'RISK_PERIOD'
  | 'COUNTERPARTY_DISTINCTNESS'
  | 'GOODS_PERMISSIBILITY'
  | 'DISCLOSURE_ACCURACY'
  | 'TEMPLATE_DRIFT';

export const CHECK_CODES: readonly CheckCode[] = [
  'SEQUENCE_INTEGRITY',
  'EVIDENCE_COMPLETENESS',
  'RISK_PERIOD',
  'COUNTERPARTY_DISTINCTNESS',
  'GOODS_PERMISSIBILITY',
  'DISCLOSURE_ACCURACY',
  'TEMPLATE_DRIFT',
];

export interface Finding {
  readonly checkCode: CheckCode;
  readonly control: string;
  readonly reason: string;
  readonly severity: IncidentSeverity;
  /** Codes and references only. */
  readonly context: Readonly<Record<string, string>>;
}

export interface CheckInput {
  readonly transaction: Transaction;
  readonly evidence: readonly EvidenceRecord[];
  /** The structure the transaction runs under. */
  readonly structure: StructureDefinition;
  /** The institution's registration, as it stands. */
  readonly institutionCr: string;
  /**
   * The goods the transaction financed and the board's register at opening
   * and now; undefined where the opening did not record its goods (before W6b).
   */
  readonly goods?: {
    readonly lines: readonly InvoiceLineGoods[];
    readonly boardAtOpening: BoardPositions;
    readonly boardNow: BoardPositions;
  };
  /** The template versions the approval it executed under covers; undefined where that approval is not in the register. */
  readonly approvedTemplates?: readonly string[];
  /** Each leg's document rebuilt from its template and the transaction's figures: its SHA-256, by leg id. */
  readonly rebuiltHashes: ReadonlyMap<string, string>;
  /** Attested: the instant the checks run at. */
  readonly observedAt: TsaInstant;
}

/** The legs a transaction in each state has executed, at least. */
const LEGS_FOR_STATE: Readonly<Record<string, readonly LegType[]>> = {
  WAAD_EXECUTED: ['WAAD'],
  PURCHASE_EXECUTED: ['WAAD', 'PURCHASE'],
  OWNERSHIP_ACQUIRED: ['WAAD', 'PURCHASE'],
  POSSESSION_CONFIRMED: ['WAAD', 'PURCHASE'],
  SALE_OFFERED: ['WAAD', 'PURCHASE', 'SALE_OFFER'],
  OFFER_LAPSED: ['WAAD', 'PURCHASE', 'SALE_OFFER'],
  EXECUTED: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
  ACTIVE: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
  SETTLED: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
  DELINQUENT: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
  HARDSHIP: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
  RESCHEDULED: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
  WRITTEN_OFF: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
  RESOLVED: ['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE'],
};
const PAST_OWNERSHIP = new Set(['OWNERSHIP_ACQUIRED', 'POSSESSION_CONFIRMED']);
const PAST_POSSESSION = new Set(['POSSESSION_CONFIRMED']);

const legsOf = (t: Transaction): readonly ContractLeg[] => ('legs' in t ? t.legs : []);

/** Every finding on the transaction, in the order the checks run. */
export function checkTransaction(input: CheckInput): readonly Finding[] {
  return [
    ...sequenceIntegrity(input),
    ...evidenceAndRiskPeriod(input),
    ...distinctness(input),
    ...goodsPermissibility(input),
    ...disclosureAccuracy(input),
    ...templateDrift(input),
  ];
}

function sequenceIntegrity({ transaction, structure }: CheckInput): readonly Finding[] {
  const out: Finding[] = [];
  const legs = legsOf(transaction);
  const chain = verifyChain(legs);
  if (!chain.ok)
    out.push({
      checkCode: 'SEQUENCE_INTEGRITY',
      control: 'SH-07',
      reason: chain.error.reason,
      severity: 'MATERIAL',
      context: { legId: String(chain.error.context?.['legId'] ?? '') },
    });
  for (const [i, leg] of legs.entries()) {
    const declared = structure.legs[i];
    if (declared?.type !== leg.legType || declared.seq !== leg.sequenceNo) {
      out.push({
        checkCode: 'SEQUENCE_INTEGRITY',
        control: 'SH-05',
        reason: 'LEGS_NOT_THE_STRUCTURE',
        severity: 'MATERIAL',
        context: { legType: leg.legType, sequenceNo: String(leg.sequenceNo) },
      });
      break;
    }
  }
  const executed = new Set(legs.map((l) => l.legType));
  const missing = (LEGS_FOR_STATE[transaction.state] ?? []).filter((t) => !executed.has(t));
  if (missing.length > 0)
    out.push({
      checkCode: 'SEQUENCE_INTEGRITY',
      control: 'SH-05',
      reason: 'STATE_AHEAD_OF_LEGS',
      severity: 'MATERIAL',
      context: { state: transaction.state, missing: missing.join(',') },
    });
  return out;
}

/**
 * Evidence as it stood at an instant: what had been captured by then. A
 * checker's decision keeps the artefact's capture time, so a decision taken
 * after the instant counts as it stands now; the sequencing engine refuses a
 * sale before its gates are decided, so this reads the sale as it was.
 */
const evidenceAt = (evidence: readonly EvidenceRecord[], at: TsaInstant): readonly EvidenceRecord[] =>
  evidence.filter((e) => !isStrictlyLater(e.capturedAt, at));

function evidenceAndRiskPeriod({ transaction, evidence, structure, observedAt }: CheckInput): readonly Finding[] {
  const out: Finding[] = [];
  const legs = legsOf(transaction);
  const required = transaction.core.riskPeriodRequiredSeconds;
  const offer = legs.find((l) => l.legType === 'SALE_OFFER');
  if (offer !== undefined) {
    // The sale as it was offered: the legs before it, the evidence captured by then, at the offer's attested instant.
    const before = legs.filter((l) => l.sequenceNo < offer.sequenceNo);
    const atSale = evaluateGates({
      definition: structure,
      legs: before,
      evidence: evidenceAt(evidence, offer.executedAt),
      riskPeriodRequiredSeconds: required,
      observedAt: offer.executedAt,
    });
    const risk = structure.gates.find((g) => g.kind === 'ELAPSE');
    for (const g of atSale.gates) {
      // A gate not started repeats its predecessor's finding; the pending one is the finding.
      if (g.status !== 'PENDING') continue;
      out.push(
        g.gateId === risk?.id
          ? {
              checkCode: 'RISK_PERIOD',
              control: 'SH-06',
              reason: 'SOLD_BEFORE_RISK_PERIOD',
              severity: 'MATERIAL',
              context: {
                requiredSeconds: String(required),
                heldSeconds: String(atSale.riskPeriodHeldSeconds ?? 0n),
              },
            }
          : {
              checkCode: 'EVIDENCE_COMPLETENESS',
              control: 'SH-05',
              reason: 'SOLD_WITHOUT_GATE',
              severity: 'MATERIAL',
              context: { gateId: g.gateId },
            },
      );
    }
    return out;
  }
  // Not yet offered: each gate the transaction is past is evidenced now.
  const now = evaluateGates({ definition: structure, legs, evidence, riskPeriodRequiredSeconds: required, observedAt });
  const [ownership, possession] = structure.gates.filter((g) => g.kind === 'EVIDENCE');
  const unsatisfied = (id: string | undefined) => id !== undefined && now.unsatisfied.some((u) => u === id);
  if (PAST_OWNERSHIP.has(transaction.state) && unsatisfied(ownership?.id))
    out.push({
      checkCode: 'EVIDENCE_COMPLETENESS',
      control: 'SH-05',
      reason: 'GATE_PASSED_WITHOUT_EVIDENCE',
      severity: 'MATERIAL',
      context: { gateId: ownership?.id ?? '' },
    });
  if (PAST_POSSESSION.has(transaction.state) && unsatisfied(possession?.id))
    out.push({
      checkCode: 'EVIDENCE_COMPLETENESS',
      control: 'SH-05',
      reason: 'GATE_PASSED_WITHOUT_EVIDENCE',
      severity: 'MATERIAL',
      context: { gateId: possession?.id ?? '' },
    });
  return out;
}

function distinctness({ transaction, institutionCr }: CheckInput): readonly Finding[] {
  const legs = legsOf(transaction);
  if (legs.length === 0) return [];
  const sellers = new Set(legs.filter((l) => l.counterpartyRole === 'SELLER').map((l) => l.counterpartyCr));
  const buyers = new Set(legs.filter((l) => l.counterpartyRole === 'BUYER').map((l) => l.counterpartyCr));
  const out: Finding[] = [];
  if (buyers.size > 1 || sellers.size > 1)
    out.push({
      checkCode: 'COUNTERPARTY_DISTINCTNESS',
      control: 'SH-08',
      reason: 'PARTY_CHANGED_BETWEEN_LEGS',
      severity: 'MATERIAL',
      context: {},
    });
  const parties = [...sellers, ...buyers, institutionCr];
  if (new Set(parties).size !== parties.length || [...sellers].some((s) => buyers.has(s)))
    out.push({
      checkCode: 'COUNTERPARTY_DISTINCTNESS',
      control: 'SH-08',
      reason: 'PARTIES_NOT_DISTINCT',
      severity: 'MATERIAL',
      context: {},
    });
  const issuer = transaction.core.tradeReference.issuerCr;
  if (sellers.size === 1 && !sellers.has(issuer))
    out.push({
      checkCode: 'COUNTERPARTY_DISTINCTNESS',
      control: 'SH-08',
      reason: 'SELLER_NOT_THE_INVOICE_ISSUER',
      severity: 'HIGH',
      context: {},
    });
  return out;
}

function goodsPermissibility({ goods }: CheckInput): readonly Finding[] {
  if (goods === undefined)
    return [
      {
        checkCode: 'GOODS_PERMISSIBILITY',
        control: 'SH-11',
        reason: 'GOODS_SCREENING_NOT_RECORDED',
        severity: 'LOW',
        context: {},
      },
    ];
  const atOpening = screenGoods(goods.lines, goods.boardAtOpening);
  if (!atOpening.ok)
    return [
      {
        checkCode: 'GOODS_PERMISSIBILITY',
        control: 'SH-11',
        reason: 'GOODS_EXCLUDED_AT_OPENING',
        severity: 'MATERIAL',
        context: { goodsClassificationCode: String(atOpening.error.context?.['goodsClassificationCode'] ?? '') },
      },
    ];
  const now = screenGoods(goods.lines, goods.boardNow);
  return now.ok
    ? []
    : [
        {
          checkCode: 'GOODS_PERMISSIBILITY',
          control: 'SH-11',
          reason: 'GOODS_EXCLUDED_SINCE',
          severity: 'MEDIUM',
          context: { goodsClassificationCode: String(now.error.context?.['goodsClassificationCode'] ?? '') },
        },
      ];
}

function disclosureAccuracy({ transaction }: CheckInput): readonly Finding[] {
  const p = transaction.core.pricing;
  return p.salePriceAmount.minorUnits === p.costAmount.minorUnits + p.profitAmount.minorUnits
    ? []
    : [
        {
          checkCode: 'DISCLOSURE_ACCURACY',
          control: 'SH-15',
          reason: 'SALE_PRICE_NOT_COST_PLUS_PROFIT',
          severity: 'MATERIAL',
          context: {},
        },
      ];
}

function templateDrift({ transaction, approvedTemplates, rebuiltHashes }: CheckInput): readonly Finding[] {
  const legs = legsOf(transaction);
  if (legs.length === 0) return [];
  const out: Finding[] = [];
  if (approvedTemplates === undefined)
    out.push({
      checkCode: 'TEMPLATE_DRIFT',
      control: 'SH-17',
      reason: 'EXECUTED_APPROVAL_NOT_IN_REGISTER',
      severity: 'MEDIUM',
      context: { approvalRef: transaction.core.shariahApprovalId },
    });
  for (const leg of legs) {
    if (approvedTemplates !== undefined && !approvedTemplates.includes(leg.templateVersionId))
      out.push({
        checkCode: 'TEMPLATE_DRIFT',
        control: 'SH-17',
        reason: 'TEMPLATE_NOT_IN_APPROVAL',
        severity: 'MATERIAL',
        context: { legType: leg.legType, templateVersionId: leg.templateVersionId },
      });
    const rebuilt = rebuiltHashes.get(leg.legId);
    if (rebuilt === undefined)
      out.push({
        checkCode: 'TEMPLATE_DRIFT',
        control: 'SH-17',
        reason: 'DOCUMENT_NOT_REBUILT',
        severity: 'LOW',
        context: { legType: leg.legType },
      });
    else if (rebuilt !== leg.contentHash)
      out.push({
        checkCode: 'TEMPLATE_DRIFT',
        control: 'SH-17',
        reason: 'DOCUMENT_DIFFERS_FROM_TEMPLATE',
        severity: 'MATERIAL',
        context: { legType: leg.legType, templateVersionId: leg.templateVersionId },
      });
  }
  return out;
}
