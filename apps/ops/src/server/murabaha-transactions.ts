/**
 * Murabaha transactions in the workbench (Wasl W1): an approved origination
 * request opens one transaction, in DRAFT, and staff can see where every
 * transaction stands.
 *
 * Opening is the product module's `execute()` (products/murabaha-scf/index.ts):
 * the board's structure and positions bind first (SR-025), the invoice's goods
 * are screened against the board's register (SH-11), the profit amount is
 * quoted from the tenant's catalogue, and the result is a `Draft` — never a
 * later state. A checker's approval opens a file; it executes nothing.
 *
 * The book itself — reading, replaying and persisting transactions — is the
 * shared Wasl book (services/origination/src/wasl/book.ts), which the SME
 * portal reads too; it is re-exported here for the workbench's screens.
 * Opening stays here because it reads the workbench's approved requests.
 * One transaction per request: opening twice returns the one already open.
 */
import { type TenantCode, loadCreditPolicyVersions, loadProductCatalogue } from '@sanad/config/loader.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import { coversTemplates } from '@sanad/core/shariah/approvals.ts';
import { murabahaScf } from '@sanad/products/murabaha-scf/index.ts';
import {
  type TransactionRecord,
  type TransactionView,
  WASL_PRODUCT,
  hydrate,
  structureOf,
  viewOf,
  waslPool,
  withLock,
} from '@sanad/origination/wasl/book.ts';
import { catalogueApproval, originationApproval } from '@sanad/origination/shariah/approvals.ts';
import { resolveBoard, resolveWaslParties } from '@sanad/origination/wasl/configuration.ts';
import { type TransactionEventRow, encodeCore, insertOpenedTransaction } from '@sanad/origination/wasl/persistence.ts';

import { servicingCalendarOf } from './business.ts';
import { ummAlQuraIso } from './hijri.ts';
import { invoiceGoodsLines } from './invoices.ts';
import { developmentAttestation, findApproved } from './store.ts';

export {
  type TenantTransactions,
  type TransactionRecord,
  type TransactionView,
  getTransaction,
  hydrate,
  listTransactions,
  replay,
  resetTransactions,
  structureOf,
  transactionForRequest,
  viewOf,
  withLock,
} from '@sanad/origination/wasl/book.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const DAY_MS = 86_400_000;
/** A civil date plus whole days (yyyy-mm-dd), by calendar arithmetic on the date itself; no clock is read. */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((x) => Number(x));
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Open the transaction an approved request authorises, in DRAFT. Idempotent on
 * the request: a second call returns the transaction already open.
 */
export async function openTransactionForRequest(
  tenant: TenantCode,
  requestRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return withLock(tenant, async () => {
    const book = await hydrate(tenant);
    const existing = [...book.records.values()].find((r) => r.requestRef === requestRef);
    if (existing !== undefined) return ok(viewOf(tenant, existing));
    const approved = findApproved(requestRef);
    if (approved?.core.tenantId !== tenant)
      return fail('REQUEST_NOT_APPROVED', 'Only an approved request opens a transaction', { requestRef });

    const at = developmentAttestation();
    const catalogue = loadProductCatalogue(tenant);
    if (!catalogue.ok) return catalogue;
    const entry = entryFor(catalogue.value, WASL_PRODUCT, approved.core.programmeId, at.epochSeconds);
    if (!entry.ok) return entry;
    const terms = murabahaScf.validateTerms(entry.value.terms);
    if (!terms.ok) return terms;
    const inputs = resolvePricingInputs(entry.value.pricingRule, {
      principal: approved.core.requestedAmount,
      tenorDays: approved.core.requestedTenorDays,
      asOfEpochSeconds: at.epochSeconds,
    });
    if (!inputs.ok) return inputs;
    const quote = murabahaScf.quote(terms.value, {
      tenantId: tenant,
      programmeId: approved.core.programmeId,
      counterpartyId: approved.core.counterpartyId,
      requestedAmount: approved.core.requestedAmount,
      tradeReference: approved.core.tradeReference,
      requestedTenorDays: approved.core.requestedTenorDays,
      asOf: at,
      pricing: inputs.value,
    });
    if (!quote.ok) return quote;

    const structure = structureOf(tenant);
    if (!structure.ok) return structure;
    // The board's goods register as it stands now, an approved Admin revision included (W5b).
    const board = (await resolveBoard(tenant)).value;
    if (!board.ok) return board;
    const parties = await resolveWaslParties(tenant);
    if (!parties.ok) return parties;
    // SH-17: a transaction opens only under an approval in force that covers Wasl and every template the board
    // approves — the structure's, which the transaction carries, and the catalogue's where it cites another.
    const approval = await originationApproval(tenant, WASL_PRODUCT, structure.value.shariahApprovalRef, at);
    if (!approval.ok) return approval;
    const templates = coversTemplates(
      approval.value,
      board.value.approvedTemplates.map((t) => t.templateVersionId),
    );
    if (!templates.ok) return templates;
    if (entry.value.boardRulingRef !== structure.value.shariahApprovalRef) {
      const cited = await catalogueApproval(tenant, entry.value, at);
      if (!cited.ok) return cited;
    }
    const riskGate = structure.value.gates.find((g) => g.id === 'GATE_3_RISK_PERIOD');
    if (riskGate?.kind !== 'ELAPSE')
      return fail('STRUCTURE_HAS_NO_RISK_PERIOD', 'The structure declares no risk-holding interval');
    const invoiceUuid = approved.core.tradeReference.invoiceUuid ?? '';
    const lines = invoiceGoodsLines(invoiceUuid);
    if (lines === undefined)
      return fail(
        'GOODS_LINES_UNKNOWN',
        'The invoice’s goods lines are not known, so they cannot be screened against the board’s register',
      );
    const policy = loadCreditPolicyVersions(tenant, 'wasl-distributor');
    if (!policy.ok) return policy;
    const latest = policy.value.at(-1);
    const calendar = servicingCalendarOf(tenant);
    if (latest === undefined || calendar === undefined)
      return fail('CONFIGURATION_INCOMPLETE', 'The credit policy or the tenant calendar is not configured');
    const maturity = addDays(calendar.dateAt(approved.approvedAt.epochSeconds), approved.core.requestedTenorDays);

    const transactionRef = `WT-${String(book.records.size + 1).padStart(6, '0')}`;
    const draft = murabahaScf.execute(terms.value, approved, quote.value, {
      transactionId: transactionRef,
      structure: structure.value,
      board: board.value,
      invoiceLines: lines,
      riskPeriodRequiredSeconds: riskGate.minimumSeconds,
      maturityDateGregorian: maturity,
      maturityDateHijri: ummAlQuraIso(maturity),
      decisionId: `approval:${requestRef}`,
      creditPolicyVersion: `${latest.policyId}@${latest.version}`,
      correlationId: approved.core.correlationId,
    });
    if (!draft.ok) return draft;

    const event: TransactionEventRow = {
      eventType: 'TRANSACTION_OPENED',
      fromState: null,
      toState: 'DRAFT',
      actor,
      // The goods as screened, so the Shariah review can screen them again against the register (W6b-1, SH-11).
      detail: {
        requestRef,
        approvedBy: approved.checker.principalId,
        core: encodeCore(draft.value.core),
        goods: lines.map((l) => ({ lineNo: l.lineNo, goodsClassificationCode: l.goodsClassificationCode })),
      },
      occurredAtEpochSeconds: at.epochSeconds,
    };
    const pool = waslPool();
    if (pool !== undefined) {
      const saved = await insertOpenedTransaction(pool, tenant, {
        transactionRef,
        requestRef,
        core: draft.value.core,
        event,
        parties: parties.value,
      });
      // Another process opened a transaction meanwhile: the next attempt reloads the book and takes the next reference.
      if (!saved.ok) return saved;
    }
    const record: TransactionRecord = {
      transactionRef,
      requestRef,
      transaction: draft.value,
      evidence: [],
      events: [event],
    };
    book.records.set(transactionRef, record);
    return ok(viewOf(tenant, record));
  });
}
