/**
 * The Shariah review of the Wasl book (W6b-1; BR-F03, BR-F07): every live
 * transaction re-checked from its own record — sequence, evidence, risk
 * period, parties, goods, disclosure, and each executed document rebuilt from
 * its template and compared — and each failure raised as a Shariah incident.
 *
 * It runs in the daily servicing cycle, after reconciliation, and on demand
 * from the incidents screen. It reads; it moves no transaction. Re-running it
 * raises nothing new for what is already raised (incidents.ts).
 *
 * The configuration each check reads is the one that governed the
 * transaction: the board's register at opening, the approval it was executed
 * under, the terms at opening. The goods register is also read as it stands,
 * so a heading excluded since is found. Reads no clock but the host-clock
 * stand-in (SR-006).
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, ok } from '@sanad/core/kernel/result.ts';
import { checkTransaction, type Finding } from '@sanad/products/murabaha-scf/compliance/checks.ts';
import type { InvoiceLineGoods } from '@sanad/products/murabaha-scf/structures/board-positions.ts';

import { hostClockInstant } from '../host-clock.ts';
import { shariahRegister } from '../shariah/approvals.ts';
import { raiseIncident } from '../shariah/incidents.ts';
import { type TransactionRecord, WASL_PRODUCT, hydrate, structureOf } from './book.ts';
import { resolveBoard, resolveWaslParties } from './configuration.ts';
import { instrumentHash, termsAtOpening } from './steps.ts';

export interface ShariahReview {
  /** Transactions checked. */
  readonly checked: number;
  /** Findings, raised now or already. */
  readonly findings: number;
  /** References of the incidents raised by this run. */
  readonly raised: readonly string[];
}

/** The goods the opening screened, as it recorded them; undefined where it did not (before W6b). */
export function goodsAtOpening(record: TransactionRecord): readonly InvoiceLineGoods[] | undefined {
  const opened = record.events.find((e) => e.eventType === 'TRANSACTION_OPENED');
  const goods = opened?.detail['goods'];
  if (!Array.isArray(goods)) return undefined;
  return goods.flatMap((g: unknown) => {
    const line = g as { lineNo?: unknown; goodsClassificationCode?: unknown };
    return typeof line.lineNo === 'number' && typeof line.goodsClassificationCode === 'string'
      ? [{ lineNo: line.lineNo, goodsClassificationCode: line.goodsClassificationCode }]
      : [];
  });
}

/** Every finding on one transaction, against the configuration that governed it. */
export async function findingsFor(tenant: TenantCode, record: TransactionRecord): Promise<Result<readonly Finding[]>> {
  const structure = structureOf(tenant);
  if (!structure.ok) return structure;
  const parties = await resolveWaslParties(tenant);
  if (!parties.ok) return parties;
  const t = record.transaction;
  const openedAt =
    record.events.find((e) => e.eventType === 'TRANSACTION_OPENED')?.occurredAtEpochSeconds ??
    hostClockInstant().epochSeconds;
  const lines = goodsAtOpening(record);
  const boardAtOpening = (await resolveBoard(tenant, openedAt)).value;
  const boardNow = (await resolveBoard(tenant)).value;
  const approval = (await shariahRegister(tenant)).find((a) => a.approvalRef === t.core.shariahApprovalId);
  const terms = termsAtOpening(tenant, record);
  const institutionCr = parties.value.institution.registrationNo;
  const rebuilt = new Map<string, string>();
  if (terms.ok)
    for (const leg of 'legs' in t ? t.legs : []) {
      const document = structure.value.legs.find((l) => l.type === leg.legType)?.document;
      if (document !== undefined)
        rebuilt.set(leg.legId, instrumentHash(leg, { document, institutionCr, terms: terms.value, core: t.core }));
    }
  return ok(
    checkTransaction({
      transaction: t,
      evidence: record.evidence,
      structure: structure.value,
      institutionCr,
      ...(lines === undefined || !boardAtOpening.ok || !boardNow.ok
        ? {}
        : { goods: { lines, boardAtOpening: boardAtOpening.value, boardNow: boardNow.value } }),
      ...(approval === undefined ? {} : { approvedTemplates: approval.templateVersionIds }),
      rebuiltHashes: rebuilt,
      observedAt: hostClockInstant(),
    }),
  );
}

/** Check every live transaction in the tenant's Wasl book and raise each failure, once. */
export async function runShariahReview(tenant: TenantCode, actor: string): Promise<Result<ShariahReview>> {
  const book = await hydrate(tenant);
  const live = [...book.records.values()].filter(
    (r) => r.transaction.state !== 'DRAFT' && r.transaction.state !== 'REJECTED',
  );
  let findings = 0;
  const raised: string[] = [];
  for (const record of live) {
    const found = await findingsFor(tenant, record);
    if (!found.ok) return found;
    findings += found.value.length;
    for (const f of found.value) {
      const r = await raiseIncident(tenant, actor, {
        subjectRef: record.transactionRef,
        productCode: WASL_PRODUCT,
        checkCode: f.checkCode,
        control: f.control,
        reason: f.reason,
        context: f.context,
        severity: f.severity,
      });
      if (!r.ok) return r;
      if (r.value !== undefined) raised.push(r.value.incidentRef);
    }
  }
  return ok({ checked: live.length, findings, raised });
}
