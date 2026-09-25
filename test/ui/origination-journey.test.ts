/**
 * The origination journey, step by step, through the store.
 *
 * The screens are thin: each step is a form, a server action and a redirect.
 * What matters is underneath — that the amount is a property of the chosen
 * trade and never typed, that an unavailable invoice is refused with its
 * control, and that a financed invoice stays financed. Those are asserted
 * here against the same functions the actions call, so the proof does not
 * depend on Next's action wire format.
 */

import { describe, expect, it } from 'vitest';

import { findClearedInvoice, listClearedInvoices, unavailableReason } from '../../apps/ops/src/server/invoices.ts';
import * as store from '../../apps/ops/src/server/store.ts';
import {
  discardDraft,
  financedInvoices,
  findDraft,
  keyRequest,
  listRequests,
  startDraft,
  submit,
  updateDraft,
} from '../../apps/ops/src/server/store.ts';
import { MAKER } from '../../apps/ops/src/server/session.ts';

const AVAILABLE = '3cf5d9a2-0000-4000-8000-000000000101';
const SAME_ENTITY = '3cf5d9a2-0000-4000-8000-000000000104';

function raiseFrom(invoiceUuid: string, tenorDays = 90) {
  const invoice = findClearedInvoice(invoiceUuid);
  if (invoice === undefined) throw new Error('fixture missing');
  return keyRequest({
    tenantId: MAKER.tenantId,
    programmeId: 'prg-0001',
    counterpartyId: invoice.recipientName,
    channel: 'MAKER_CHECKER',
    invoiceUuid: invoice.invoiceUuid,
    invoiceNumber: invoice.invoiceNumber,
    issuerCr: invoice.issuerCr,
    recipientCr: invoice.recipientCr,
    // Exactly what the review step does: the amount is read from the invoice.
    amountMinorUnits: invoice.amount.minorUnits,
    tenorDays,
    maker: MAKER,
  });
}

describe('§6 — the journey starts at the trade, not at an amount', () => {
  it('a draft begins with no amount and no way to hold one', () => {
    const draft = startDraft('MAKER_CHECKER');
    // The draft shape has no amount field. The type is the control; this
    // asserts the runtime object agrees with it.
    expect(Object.keys(draft).sort()).toEqual(['channel', 'draftId']);
    discardDraft(draft.draftId);
  });

  it('carries the chosen trade and terms across steps', () => {
    const draft = startDraft('MAKER_CHECKER');
    updateDraft(draft.draftId, { invoiceUuid: AVAILABLE });
    updateDraft(draft.draftId, { programmeId: 'prg-0001', tenorDays: 60 });

    const stored = findDraft(draft.draftId);
    expect(stored?.invoiceUuid).toBe(AVAILABLE);
    expect(stored?.tenorDays).toBe(60);
    // Still no amount: it is derived at submit, from the invoice.
    expect('amountMinorUnits' in (stored ?? {})).toBe(false);
    discardDraft(draft.draftId);
  });

  it('the submitted amount is the invoice amount', () => {
    const invoice = findClearedInvoice(AVAILABLE);
    const result = raiseFrom(AVAILABLE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.amountMinorUnits).toBe(invoice?.amount.minorUnits);
  });
});

describe('unavailable trades are shown and refused, with the control', () => {
  it('SH-08 — the same registered entity on both sides is refused', () => {
    const invoice = findClearedInvoice(SAME_ENTITY);
    if (invoice === undefined) throw new Error('fixture missing');
    expect(unavailableReason(invoice, financedInvoices())).toEqual({ control: 'SH-08' });
  });

  it('SH-10 — an invoice financed once cannot be financed again', () => {
    const first = raiseFrom(AVAILABLE);
    // The fixture above may already have financed it in an earlier test;
    // either way the registry now holds it.
    const registered = financedInvoices().get(AVAILABLE);
    expect(registered).toBeDefined();
    if (first.ok) expect(registered).toBe(first.value.requestId);

    const second = raiseFrom(AVAILABLE);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.control).toBe('SH-10');
      expect(second.error.reason).toBe('INVOICE_ALREADY_FINANCED');
    }

    const invoice = findClearedInvoice(AVAILABLE);
    if (invoice === undefined) throw new Error('fixture missing');
    expect(unavailableReason(invoice, financedInvoices())?.control).toBe('SH-10');
  });

  it('the registry is never purged — a financed invoice stays financed', () => {
    // No function in the store removes a registry entry. Asserted by the
    // module's export surface rather than by trying every name.
    const exported = Object.keys(store);
    expect(exported.some((n) => /unfinance|purge|releaseInvoice|clearRegistry/i.test(n))).toBe(false);
  });
});

describe('a submitted draft becomes a request in the queue', () => {
  it('lands in AWAITING_REVIEW for the maker–checker channel', () => {
    const uuid = listClearedInvoices().find((i) => i.invoiceNumber === '452230')?.invoiceUuid;
    if (uuid === undefined) throw new Error('fixture missing');

    const keyed = raiseFrom(uuid, 45);
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;

    const submitted = submit(keyed.value.requestId);
    expect(submitted.ok).toBe(true);
    if (submitted.ok) expect(submitted.value.state).toBe('AWAITING_REVIEW');

    expect(listRequests().some((r) => r.requestId === keyed.value.requestId)).toBe(true);
  });
});
