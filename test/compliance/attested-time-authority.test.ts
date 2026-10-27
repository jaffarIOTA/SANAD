/**
 * SR-006, SH-06: with a timestamping authority configured, every instant a
 * Murabaha transaction relies on is the authority's, over the thing it attests.
 * Each case attempts what must not happen and passes only when it fails:
 *
 *   - a leg whose time is not the authority's token over that leg;
 *   - possession evidence whose time is not a token over that very file;
 *   - a step taken while the authority is down, or with a time not later than
 *     the last, or by the host clock standing in for the authority;
 *   - a deployment with neither an authority nor a synthetic declaration
 *     getting a time from anywhere at all;
 *   - an authority's leg passing the drift check on the old, time-inside hash.
 *
 * In memory (bank-a), with the in-process authority of test/support/test-tsa.ts
 * issuing real RFC 3161 tokens that the adapter verifies.
 */
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import type { StampedTimestamp } from '@sanad/core/time/tsa.ts';
import { verifyAnchoredChain } from '@sanad/products/murabaha-scf/legs/anchor.ts';
import type { ContractLeg } from '@sanad/products/murabaha-scf/legs/leg.ts';

import { Rfc3161TimestampAuthority, type TsaTransport } from '../../adapters/tsa/adapter.ts';
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
import { openTransactionForRequest, resetTransactions } from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import {
  authorityTimeSource,
  resetTimeSources,
  timeSourceFor,
  useTimeSourceForTests,
} from '../../services/origination/src/attested-time.ts';
import { HOST_CLOCK_AUTHORITY } from '../../services/origination/src/host-clock.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import { resetShariahIncidents } from '../../services/origination/src/shariah/incidents.ts';
import { replayTransaction } from '../../services/origination/src/wasl/audit.ts';
import { hydrate } from '../../services/origination/src/wasl/book.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import {
  acceptSaleOffer,
  instrumentHash,
  legacyInstrumentHash,
  rebuiltInstrumentHash,
  termsAtOpening,
} from '../../services/origination/src/wasl/steps.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { TEST_TSA_POLICY, type TestTsa, testTsa } from '../support/test-tsa.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e6d1000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const HOUR = 3600;
const AUTHORITY = 'institution-tsa';

let clock = Date.UTC(2026, 9, 28, 6, 0, 0);
let tsa: TestTsa;
let down = false;
/** Every token the authority issued, by its digest: what the database's tsa_token columns hold. */
const issued = new Map<string, Uint8Array>();

const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
  tsa.setNow(BigInt(clock / 1000));
};

function authority(): Rfc3161TimestampAuthority {
  const live = tsa.transport();
  const transport: TsaTransport = {
    exchange: (request) => (down ? Promise.reject(new Error('ECONNREFUSED')) : live.exchange(request)),
  };
  return new Rfc3161TimestampAuthority({
    authorityId: AUTHORITY,
    transport,
    trustAnchors: [tsa.root.x509],
    policy: TEST_TSA_POLICY,
    nowEpochSeconds: () => Math.floor(clock / 1000),
  });
}

beforeEach(async () => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  tsa = testTsa(BigInt(clock / 1000));
  down = false;
  issued.clear();
  resetTransactions();
  resetFacilities();
  resetShariahApprovals();
  resetShariahIncidents();
  resetTimeSources();
  await approveTestFacilities();
  await recordTestApprovals();
  const a = authority();
  const recording = {
    async stamp(d: string): Promise<StampedTimestamp | undefined> {
      const s = await a.stamp(d);
      if (s !== undefined) issued.set(s.tokenDigest, s.token);
      return s;
    },
    verify: (token: Uint8Array, d: string) => a.verify(token, d),
  };
  useTimeSourceForTests(T, authorityTimeSource(recording));
});
afterEach(() => {
  resetTimeSources();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

let serial = 0;
const fileOf = (ref: string): Uint8Array => new TextEncoder().encode(`%PDF-1.7\n% delivery ${ref}\n%%EOF\n`);

/** A transaction taken as far as `until`, every step a second after the last. */
async function transaction(until: 'POSSESSION' | 'ACCEPTED'): Promise<string> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: `9e6d1000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceNumber: `TSA-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  expectOk(approveRequest(keyed.requestId, { principalId: 'stf-senior-01', tenantId: T }));
  advance(1);
  const ref = expectOk(await openTransactionForRequest(T, keyed.requestId, 'stf-senior-01')).transactionRef;
  for (const s of [validateAndReserve, executeWaad, executePurchase]) {
    advance(1);
    expectOk(await s(T, ref, MAKER));
  }
  advance(1);
  expectOk(
    await recordOwnershipInvoice(T, ref, MAKER, {
      invoiceUuid: `7b1e0c4a-6d6d-4000-9000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-tsa-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'ANCHOR_SYSTEM',
      bytes: fileOf(ref),
    }),
  );
  advance(1);
  const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
  expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
  advance(1);
  expectOk(await confirmPossession(T, ref, MAKER));
  if (until === 'POSSESSION') return ref;
  advance(HOUR + 60);
  expectOk(await offerSale(T, ref, MAKER));
  advance(60);
  expectOk(
    await acceptSaleOffer(T, ref, 'distributor:sig-rawabi-01', {
      assertionId: `demo-approve-tsa-${String(serial)}`,
      offerHash: 'a'.repeat(64),
      signatoryRef: 'sig-rawabi-01',
    }),
  );
  return ref;
}

const legsOf = async (ref: string): Promise<readonly ContractLeg[]> => {
  const t = (await hydrate(T)).records.get(ref)?.transaction;
  return t !== undefined && 'legs' in t ? t.legs : [];
};

describe('a Murabaha transaction under a timestamping authority', () => {
  it('times every leg by the authority’s token over that leg, and the chain verifies against the tokens', async () => {
    const ref = await transaction('ACCEPTED');
    const legs = await legsOf(ref);
    expect(legs.length).toBeGreaterThanOrEqual(4);
    for (const leg of legs) {
      expect(leg.executedAt.authorityId).toBe(AUTHORITY);
      expect(issued.has(leg.tsaTokenDigest)).toBe(true);
    }
    const verified = await verifyAnchoredChain(
      legs,
      (leg) => Promise.resolve(issued.get(leg.tsaTokenDigest)),
      authority(),
    );
    expect(verified).toEqual({ ok: true, value: true });

    // A token kept for one leg does not attest another (no reuse, SR-006).
    const [first, second] = legs;
    const swapped = await verifyAnchoredChain(
      legs,
      (leg) => Promise.resolve(issued.get((leg === second ? first : leg)?.tsaTokenDigest ?? '')),
      authority(),
    );
    expect(swapped).toMatchObject({ ok: false, error: { reason: 'ANCHOR_INVALID' } });
  });

  it('times possession evidence by a token over that very file', async () => {
    const ref = await transaction('POSSESSION');
    const record = (await hydrate(T)).records.get(ref);
    const delivery = record?.evidence.find((e) => e.evidenceType === 'DELIVERY_NOTE');
    const fileHash = createHash('sha256').update(fileOf(ref)).digest('hex');
    expect(delivery?.artefactHash).toBe(fileHash);
    expect(delivery?.capturedAt.authorityId).toBe(AUTHORITY);
    const token = issued.get(delivery?.capturedAt.tokenDigest ?? '');
    expect(await authority().verify(token ?? new Uint8Array(), fileHash)).toMatchObject({
      genTimeEpochSeconds: delivery?.capturedAt.epochSeconds,
    });
    expect(
      await authority().verify(token ?? new Uint8Array(), createHash('sha256').update('other').digest('hex')),
    ).toBe(undefined);
  });

  it('replays clean for the Board: links, times and documents as the template makes them', async () => {
    const ref = await transaction('ACCEPTED');
    const replay = expectOk(await replayTransaction(T, ref));
    expect(replay.chain.verified).toBe(true);
    for (const leg of replay.legs) {
      expect(leg.timestampAuthority).toBe(AUTHORITY);
      expect(leg.linkedToPrevious && leg.timeAfterPrevious).toBe(true);
      expect(leg.documentMatchesTemplate).toBe(true);
    }
  });
});

describe('no trusted time, no step', () => {
  it('refuses the step and writes nothing while the authority is down', async () => {
    const ref = await transaction('POSSESSION');
    down = true;
    advance(HOUR + 60);
    const refused = await offerSale(T, ref, MAKER);
    expect(refused).toMatchObject({ ok: false, error: { control: 'SH-06', reason: 'TIMESTAMP_UNAVAILABLE' } });
    expect((await hydrate(T)).records.get(ref)?.transaction.state).toBe('POSSESSION_CONFIRMED');
    // The authority is back: the same step goes through, under its time.
    down = false;
    expectOk(await offerSale(T, ref, MAKER));
  });

  it('refuses a time the authority gives that is not later than the transaction’s last', async () => {
    const ref = await transaction('POSSESSION');
    tsa.setNow(BigInt(clock / 1000) - 10n);
    vi.setSystemTime(clock + (HOUR + 60) * 1000);
    const refused = await offerSale(T, ref, MAKER);
    expect(refused).toMatchObject({ ok: false, error: { reason: 'TIMESTAMP_UNAVAILABLE' } });
  }, 10_000);

  it('gives a deployment with neither an authority nor a synthetic declaration no time at all', async () => {
    resetTimeSources();
    const source = await timeSourceFor(T, { NODE_ENV: 'production', SANAD_DATABASE_URL: '' });
    expect(source.kind).toBe('NONE');
    expect(await source.attest('0'.repeat(64))).toBeUndefined();
    expect((await timeSourceFor(T, { NODE_ENV: 'test', SANAD_DATABASE_URL: '' })).kind).toBe('HOST_CLOCK');
  });
});

describe('the drift check across hash versions', () => {
  it('rebuilds the time-free hash for an authority’s leg, and accepts the old hash only from the host clock', async () => {
    const ref = await transaction('ACCEPTED');
    const record = (await hydrate(T)).records.get(ref);
    const [leg] = await legsOf(ref);
    if (record === undefined || leg === undefined) throw new Error('no leg');
    const terms = expectOk(termsAtOpening(T, record));
    const facts = { document: 'PURCHASE_AGREEMENT', institutionCr: '7001000001', terms, core: record.transaction.core };
    const current = instrumentHash(leg, facts);
    const legacy = legacyInstrumentHash(leg, facts);
    expect(current).not.toBe(legacy);

    // An authority's leg carrying the old, time-inside hash is drift: rebuilt to the current one, which differs.
    expect(rebuiltInstrumentHash({ ...leg, contentHash: legacy }, facts)).toBe(current);
    // A host-clock leg from before carries the old hash and still matches it.
    const hostLeg = { ...leg, executedAt: { ...leg.executedAt, authorityId: HOST_CLOCK_AUTHORITY } };
    const oldHostHash = legacyInstrumentHash(hostLeg, facts);
    expect(rebuiltInstrumentHash({ ...hostLeg, contentHash: oldHostHash }, facts)).toBe(oldHostHash);
    // And a host-clock leg matching neither is drift too.
    expect(rebuiltInstrumentHash({ ...hostLeg, contentHash: 'f'.repeat(64) }, facts)).toBe(current);
  });
});
