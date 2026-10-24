/**
 * Wasl W3 — the distributor accepts in the SME portal, and the sale is
 * booked. Each case attempts something the portal must refuse, and passes
 * only when it is refused:
 *
 *   - signing in as a reference that signs for no distributor;
 *   - one distributor's signatory seeing or accepting another's offer (BOLA):
 *     not found, exactly as one that does not exist;
 *   - accepting without a signature, with a signature request spent before,
 *     or with one that outlived its window;
 *   - accepting an offer that has lapsed;
 *   - booking twice.
 *
 * The happy path: a signatory signs in through the national identity service
 * (the demonstration transport), signs the offer instrument's hash, accepts —
 * the assertion and the hash recorded on the acceptance — and the obligation
 * is booked: the core's receivable reference, the schedule summing to the
 * fixed sale price. When the core does not take the booking, the sale stays
 * concluded and is booked later, once.
 *
 * Cookies are a jar standing in for `next/headers`; time is the host-clock
 * stand-in, moved with fake timers. The book is in memory (bank-a).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { signatoryOf } from '@sanad/config/loader.ts';

import {
  acquireOwnership,
  confirmPossession,
  decidePossessionEvidence,
  executePurchase,
  executeWaad,
  offerSale,
  recordOwnershipInvoice,
  recordPossessionEvidence,
  validateAndReserve,
} from '../../apps/ops/src/server/murabaha-sequencing.ts';
import {
  type TransactionView,
  getTransaction,
  openTransactionForRequest,
  resetTransactions,
} from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';
import {
  confirmAcceptance,
  confirmSignIn,
  myTransaction,
  myTransactions,
  startAcceptance,
  startSignIn,
} from '../../apps/sme/src/server/portal.ts';
import { currentSession } from '../../apps/sme/src/server/session.ts';
import { bookExecutedSale } from '../../services/origination/src/wasl/booking.ts';

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
}));

// The core banking configuration the test can withdraw, to attempt a booking the core cannot take.
const core = vi.hoisted(() => ({ withdrawn: false }));
vi.mock('@sanad/config/loader.ts', async (original) => {
  const actual = await original<typeof import('@sanad/config/loader.ts')>();
  return {
    ...actual,
    loadMurabahaAccounts: (tenant: Parameters<typeof actual.loadMurabahaAccounts>[0]) =>
      core.withdrawn
        ? { ok: false, error: { control: 'OP-DETERMINACY', reason: 'MURABAHA_ACCOUNTS_NOT_CONFIGURED', detail: '' } }
        : actual.loadMurabahaAccounts(tenant),
  };
});

const TEST_INVOICES = '9e200000-0000-4000-8000-';
vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e200000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const RAWABI = 'Rawabi Industrial Supplies Establishment';
const TAMAM = 'Tamam Foodstuff Trading Company';
const HOUR = 3600;

const reason = (r: { ok: boolean; error?: { control: string; reason: string } }) =>
  r.ok ? 'done' : `${r.error?.control} ${r.error?.reason}`;

let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

beforeEach(async () => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  jar.clear();
  core.withdrawn = false;
  resetTransactions();
  resetFacilities();
  await approveTestFacilities();
});
afterEach(() => {
  vi.useRealTimers();
});

let serial = 0;
/** A transaction for `counterparty`, walked by the bank to its sale offer. */
async function offeredTo(counterparty: string): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: counterparty,
      channel: 'MAKER_CHECKER',
      invoiceUuid: `${TEST_INVOICES}${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W3-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  expectOk(approveRequest(keyed.requestId, { principalId: 'stf-senior-01', tenantId: T }));
  const ref = expectOk(await openTransactionForRequest(T, keyed.requestId, 'stf-senior-01')).transactionRef;
  for (const s of [validateAndReserve, executeWaad, executePurchase]) {
    advance(1);
    expectOk(await s(T, ref, MAKER));
  }
  advance(1);
  expectOk(
    await recordOwnershipInvoice(T, ref, MAKER, {
      invoiceUuid: `7b1e0c4a-4444-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-w3-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'ANCHOR_SYSTEM',
      bytes: new TextEncoder().encode(`%PDF-1.7\n% delivery ${ref}\n%%EOF\n`),
    }),
  );
  advance(1);
  const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
  expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
  advance(1);
  expectOk(await confirmPossession(T, ref, MAKER));
  advance(HOUR + 60);
  return expectOk(await offerSale(T, ref, MAKER));
}

/** Sign in through the identity service as `signatoryRef`, in a fresh browser. */
async function signedInAs(signatoryRef: string) {
  jar.clear();
  expectOk(await startSignIn(signatoryRef));
  advance(1);
  expectOk(await confirmSignIn());
  const s = await currentSession();
  if (s === undefined) throw new Error('no session');
  return s;
}

describe('the distributor accepts in the SME portal', () => {
  it('a reference that signs for no distributor does not sign in', async () => {
    expect(signatoryOf('sig-rawabi-01')?.distributor.counterpartyId).toBe(RAWABI);
    expect(signatoryOf('someone-else')).toBeUndefined();
    expect(reason(await startSignIn('someone-else'))).toBe('OP-DETERMINACY SIGN_IN_REFUSED');
    expect(reason(await confirmSignIn())).toBe('OP-DETERMINACY SIGN_IN_EXPIRED');
    expect(await currentSession()).toBeUndefined();
  });

  it('the session names the distributor the configuration says, not one the person chose', async () => {
    const s = await signedInAs('sig-tamam-01');
    expect(s).toMatchObject({ tenant: T, counterpartyId: TAMAM, signatoryRef: 'sig-tamam-01' });
    expect(s.identityAssertionId).toMatch(/^demo-approve-/);
  });

  it('another distributor’s offer is not found, and cannot be accepted (BOLA)', async () => {
    const offered = await offeredTo(RAWABI);
    const tamam = await signedInAs('sig-tamam-01');
    expect(await myTransaction(tamam, offered.transactionRef)).toBeUndefined();
    expect((await myTransactions(tamam)).map((m) => m.view.transactionRef)).not.toContain(offered.transactionRef);
    expect(reason(await startAcceptance(tamam, offered.transactionRef))).toBe('OP-DETERMINACY TRANSACTION_NOT_FOUND');
    expect((await getTransaction(T, offered.transactionRef))?.transaction.state).toBe('SALE_OFFERED');
  });

  it('accepts only with a signature on this offer, records it, and books the obligation once', async () => {
    const offered = await offeredTo(RAWABI);
    const offerLeg = offered.transaction.state === 'SALE_OFFERED' ? offered.transaction.legs.at(-1) : undefined;
    const rawabi = await signedInAs('sig-rawabi-01');
    expect((await myTransactions(rawabi)).map((m) => m.view.transactionRef)).toContain(offered.transactionRef);

    // No signature requested: nothing to confirm.
    expect(reason(await confirmAcceptance(rawabi))).toBe('OP-DETERMINACY SIGNATURE_EXPIRED');
    expectOk(await startAcceptance(rawabi, offered.transactionRef));
    const pendingCookie = jar.get('sanad_sme_pending');
    advance(1);
    const done = expectOk(await confirmAcceptance(rawabi));
    expect(done).toEqual({ transactionRef: offered.transactionRef, booked: true });

    // The same signature request, replayed: spent.
    if (pendingCookie !== undefined) jar.set('sanad_sme_pending', pendingCookie);
    expect(reason(await confirmAcceptance(rawabi))).toBe('OP-DETERMINACY SIGNATURE_EXPIRED');

    const after = await getTransaction(T, offered.transactionRef);
    expect(after?.transaction.state).toBe('ACTIVE');
    const accepted = after?.events.find((e) => e.eventType === 'OFFER_ACCEPTED');
    expect(accepted?.actor).toBe('distributor:sig-rawabi-01');
    expect(accepted?.detail).toMatchObject({
      signedOfferHash: offerLeg?.contentHash,
      signatoryRef: 'sig-rawabi-01',
      identityAssertionId: expect.stringMatching(/^demo-approve-/),
    });
    const booked = after?.events.find((e) => e.eventType === 'OBLIGATION_BOOKED');
    const obligation = booked?.detail['obligation'] as {
      bookingRef: string;
      totalMinor: string;
      instalments: { amountMinor: string; dueDateGregorian: string }[];
    };
    expect(obligation.bookingRef).toMatch(/^TRX-DEMO-/);
    expect(obligation.totalMinor).toBe(offered.transaction.core.pricing.salePriceAmount.minorUnits.toString());
    // The schedule sums to the fixed sale price, and the last instalment falls on the stored maturity.
    expect(obligation.instalments.reduce((s, i) => s + BigInt(i.amountMinor), 0n).toString()).toBe(
      obligation.totalMinor,
    );
    expect(obligation.instalments.at(-1)?.dueDateGregorian).toBe(offered.transaction.core.maturityDateGregorian);
    // A profit amount, never a rate: nothing the acceptance or the booking recorded names one (M-1).
    expect(JSON.stringify([accepted?.detail, booked?.detail])).not.toMatch(/rate|apr|"bp"/i);

    // Booked once: a second booking finds nothing to book.
    expect(reason(await bookExecutedSale(T, offered.transactionRef, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');
  });

  it('a signature request that outlives its window accepts nothing, and a lapsed offer stays lapsed', async () => {
    const offered = await offeredTo(RAWABI);
    const rawabi = await signedInAs('sig-rawabi-01');
    expectOk(await startAcceptance(rawabi, offered.transactionRef));
    // The offer lapses while the person is signing; the bank records the lapse.
    advance(2 * 86_400 + 1);
    const { lapseSaleOffer } = await import('../../apps/ops/src/server/murabaha-sequencing.ts');
    expectOk(await lapseSaleOffer(T, offered.transactionRef, MAKER));
    expect(reason(await confirmAcceptance(rawabi))).toBe('OP-DETERMINACY SIGNATURE_EXPIRED');
    expect((await getTransaction(T, offered.transactionRef))?.transaction.state).toBe('OFFER_LAPSED');
  });

  it('a lapsed offer is not offered for signature', async () => {
    const offered = await offeredTo(RAWABI);
    advance(2 * 86_400 + 1);
    const rawabi = await signedInAs('sig-rawabi-01');
    expect(reason(await startAcceptance(rawabi, offered.transactionRef))).toBe('SH-03 OFFER_EXPIRED');
  });

  it('when the core does not take the booking, the sale stays concluded and is booked later, once', async () => {
    const offered = await offeredTo(RAWABI);
    const rawabi = await signedInAs('sig-rawabi-01');
    core.withdrawn = true;
    expectOk(await startAcceptance(rawabi, offered.transactionRef));
    advance(1);
    expect(expectOk(await confirmAcceptance(rawabi))).toEqual({
      transactionRef: offered.transactionRef,
      booked: false,
    });
    expect((await getTransaction(T, offered.transactionRef))?.transaction.state).toBe('EXECUTED');
    expect(reason(await bookExecutedSale(T, offered.transactionRef, MAKER))).toBe(
      'OP-DETERMINACY MURABAHA_ACCOUNTS_NOT_CONFIGURED',
    );
    core.withdrawn = false;
    advance(1);
    expect(expectOk(await bookExecutedSale(T, offered.transactionRef, MAKER)).transaction.state).toBe('ACTIVE');
    expect(reason(await bookExecutedSale(T, offered.transactionRef, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');
  });
});
