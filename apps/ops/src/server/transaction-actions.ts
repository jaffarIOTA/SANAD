'use server';

/**
 * Server actions for a Murabaha transaction's sequence (Wasl W2).
 *
 * Thin, like `actions.ts`: parse the form, call the step in
 * murabaha-sequencing.ts, redirect back with a notice code — or, on a refusal,
 * with the control code and the reason code only; the transaction page words
 * them from its own map, so nothing a link carries is shown as the
 * institution's words. None of them contains a rule, and none can move a
 * transaction anywhere the sequencing engine does not: each calls the one
 * step it names, which refuses in any state that step does not belong to.
 *
 * Who acts is the signed-in principal (`authorise()`), never the form
 * (BE-09); the tenant is theirs. Operations' acts need MAKER; validating
 * possession evidence a checker, and never the person who recorded it (the
 * service compares people); unwinding a checker, recently signed in.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';

import { bookExecutedSale } from '@sanad/origination/wasl/booking.ts';

import type { WorkbenchAct } from './authority.ts';
import {
  acquireOwnership,
  confirmPossession,
  decidePossessionEvidence,
  executePurchase,
  executeWaad,
  lapseSaleOffer,
  offerSale,
  recordOwnershipInvoice,
  recordPossessionEvidence,
  unwindTransaction,
  validateAndReserve,
} from './murabaha-sequencing.ts';
import { authorise, localeSegmentOf } from './session.ts';

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();

interface Context {
  readonly locale: string;
  readonly tenant: TenantCode;
  readonly transactionRef: string;
  readonly path: string;
  readonly actor: string;
}

async function contextOf(form: FormData, act: WorkbenchAct): Promise<Context> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const ref = field(form, 'transactionRef');
  // A path from the transaction's own reference, checked for shape — never a path from the form.
  const transactionRef = /^WT-\d{6,10}$/.test(ref) ? ref : '';
  const path = transactionRef === '' ? `/${locale}/transactions` : `/${locale}/transactions/${transactionRef}`;
  const staff = await authorise(locale, act, path);
  return { locale, tenant: staff.tenantId as TenantCode, transactionRef, path, actor: staff.principalId };
}

/** Take the step, then send the browser back with a notice, or with the refusal's codes only. */
async function finish(ctx: Context, change: () => Promise<Result<unknown>>, notice: string): Promise<never> {
  const result = await change();
  revalidatePath(`/${ctx.locale}/transactions`);
  revalidatePath(ctx.path);
  const query = result.ok
    ? new URLSearchParams({ notice })
    : new URLSearchParams({ control: result.error.control, reason: result.error.reason });
  redirect(`${ctx.path}?${query.toString()}`);
}

/** The steps that take nothing but the decision to take them, by the name the form gives. */
const PLAIN_STEPS = {
  RESERVE: { act: 'TRADE_OPERATIONS', run: validateAndReserve, notice: 'LIMIT_RESERVED' },
  WAAD: { act: 'TRADE_OPERATIONS', run: executeWaad, notice: 'WAAD_EXECUTED' },
  PURCHASE: { act: 'TRADE_OPERATIONS', run: executePurchase, notice: 'PURCHASE_EXECUTED' },
  OWNERSHIP: { act: 'TRADE_OPERATIONS', run: acquireOwnership, notice: 'OWNERSHIP_ACQUIRED' },
  POSSESSION: { act: 'TRADE_OPERATIONS', run: confirmPossession, notice: 'POSSESSION_CONFIRMED' },
  OFFER: { act: 'TRADE_OPERATIONS', run: offerSale, notice: 'SALE_OFFERED' },
  LAPSE: { act: 'TRADE_OPERATIONS', run: lapseSaleOffer, notice: 'OFFER_LAPSED' },
  // An accepted sale whose booking the core did not take when the distributor accepted: the same receivable, idempotently.
  BOOK: { act: 'TRADE_OPERATIONS', run: bookExecutedSale, notice: 'OBLIGATION_BOOKED' },
} as const satisfies Readonly<
  Record<
    string,
    {
      readonly act: WorkbenchAct;
      readonly run: (t: TenantCode, ref: string, actor: string) => Promise<Result<unknown>>;
      readonly notice: string;
    }
  >
>;

/** One sequencing step. A step name the form invents is refused before anything is called. */
export async function sequenceStepAction(form: FormData): Promise<void> {
  const name = field(form, 'step');
  const step = Object.hasOwn(PLAIN_STEPS, name) ? PLAIN_STEPS[name as keyof typeof PLAIN_STEPS] : undefined;
  const ctx = await contextOf(form, step?.act ?? 'TRADE_OPERATIONS');
  if (step === undefined)
    return finish(
      ctx,
      () => Promise.resolve({ ok: false, error: { control: 'OP-DETERMINACY', reason: 'STEP_UNKNOWN', detail: '' } }),
      '',
    );
  return finish(ctx, () => step.run(ctx.tenant, ctx.transactionRef, ctx.actor), step.notice);
}

/** Gate 1: the anchor's invoice to the institution, named by UUID and hash; the e-invoicing authority answers. */
export async function ownershipInvoiceAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'TRADE_OPERATIONS');
  return finish(
    ctx,
    () =>
      recordOwnershipInvoice(ctx.tenant, ctx.transactionRef, ctx.actor, {
        invoiceUuid: field(form, 'invoiceUuid'),
        invoiceHash: field(form, 'invoiceHash'),
      }),
    'OWNERSHIP_EVIDENCE_RECORDED',
  );
}

/** Gate 2: a possession document's file, its type and where it came from. The file's name and declared type are not read. */
export async function possessionEvidenceAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'TRADE_OPERATIONS');
  const file = form.get('file');
  const bytes = file instanceof Blob && file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array();
  return finish(
    ctx,
    () =>
      recordPossessionEvidence(ctx.tenant, ctx.transactionRef, ctx.actor, {
        evidenceType: field(form, 'evidenceType'),
        source: field(form, 'source'),
        bytes,
      }),
    'POSSESSION_EVIDENCE_RECORDED',
  );
}

/** A checker validates or refuses possession evidence someone else recorded. */
export async function decideEvidenceAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'TRADE_EVIDENCE_VERIFY');
  const decision = field(form, 'decision') === 'VALID' ? 'VALID' : 'INVALID';
  return finish(
    ctx,
    () => decidePossessionEvidence(ctx.tenant, ctx.transactionRef, ctx.actor, field(form, 'evidenceId'), decision),
    decision === 'VALID' ? 'EVIDENCE_VALIDATED' : 'EVIDENCE_REFUSED',
  );
}

/** Unwind before the sale, with what happens to the goods, in the checker's words (kept on the transaction, never in a URL). */
export async function unwindAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'TRADE_UNWIND');
  return finish(
    ctx,
    () => unwindTransaction(ctx.tenant, ctx.transactionRef, ctx.actor, field(form, 'goodsDisposition').slice(0, 500)),
    'UNWOUND',
  );
}
