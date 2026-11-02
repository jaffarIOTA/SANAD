/**
 * SR-006 on PostgreSQL: with a timestamping authority, each contract leg keeps
 * its RFC 3161 token in core.contract_leg.tsa_token and each piece of
 * possession evidence in evidence.evidence.captured_tsa_token (migration 0036):
 * the bytes themselves, whose SHA-256 is the digest beside them, and which
 * re-verify against the authority over what they attest. Neither can be
 * changed afterwards, not even by the owner.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { legAnchorDigest } from '@sanad/products/murabaha-scf/legs/anchor.ts';

import { Rfc3161TimestampAuthority } from '../../adapters/tsa/adapter.ts';
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
  openTransactionForRequest,
  resetTransactions,
} from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import {
  authorityTimeSource,
  resetTimeSources,
  useTimeSourceForTests,
} from '../../services/origination/src/attested-time.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { TEST_TSA_POLICY, testTsa } from '../support/test-tsa.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-8);
const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e360000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

// The other Wasl suites on this database start here; approvals one records are read as of each suite's own clock.
let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
const tsa = testTsa(BigInt(clock / 1000));
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
  tsa.setNow(BigInt(clock / 1000));
};
const authority = new Rfc3161TimestampAuthority({
  authorityId: 'institution-tsa',
  transport: tsa.transport(),
  trustAnchors: [tsa.root.x509],
  policy: TEST_TSA_POLICY,
  nowEpochSeconds: () => Math.floor(clock / 1000),
});

let serial = 0;
const invoiceOf = (n: number) => `9e360000-0000-4000-8000-${RUN}${String(n).padStart(4, '0')}`;
const fileOf = (ref: string) => new TextEncoder().encode(`%PDF-1.7\n% tsa ${RUN} ${ref}\n%%EOF\n`);

async function offered(): Promise<TransactionView> {
  let v: TransactionView | undefined;
  for (let attempt = 0; attempt < 100 && v === undefined; attempt += 1) {
    serial += 1;
    const keyed = expectOk(
      keyRequest({
        tenantId: T,
        programmeId: 'prg-0001',
        counterpartyId: 'Rawabi Industrial Supplies Establishment',
        channel: 'MAKER_CHECKER',
        invoiceUuid: invoiceOf(serial),
        invoiceNumber: `TSADB-${RUN}-${String(serial)}`,
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
    const o = await openTransactionForRequest(T, keyed.requestId, 'stf-senior-01');
    // Ours only if it finances the invoice just keyed: another run on this database may hold the same request number.
    if (o.ok && o.value.transaction.core.tradeReference.invoiceUuid === invoiceOf(serial)) v = o.value;
  }
  if (v === undefined) throw new Error('no fresh transaction could be opened');
  const ref = v.transactionRef;
  for (const s of [validateAndReserve, executeWaad, executePurchase]) {
    advance(1);
    expectOk(await s(T, ref, MAKER));
  }
  advance(1);
  expectOk(
    await recordOwnershipInvoice(T, ref, MAKER, {
      invoiceUuid: `7b1e0c4a-3636-4000-8000-${RUN}${String(serial).padStart(4, '0')}`,
      invoiceHash: `ownership-tsadb-${RUN}-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'PARTNER',
      bytes: fileOf(ref),
    }),
  );
  advance(1);
  const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
  expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
  advance(1);
  expectOk(await confirmPossession(T, ref, MAKER));
  advance(3600 + 60);
  return expectOk(await offerSale(T, ref, MAKER));
}

describe.skipIf(url === undefined)('timestamp tokens kept on PostgreSQL (SR-006)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    vi.stubEnv('SANAD_DATABASE_URL', url ?? '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    resetTransactions();
    resetTimeSources();
    await approveTestFacilities();
    await recordTestApprovals();
    useTimeSourceForTests(T, authorityTimeSource(authority));
  });
  afterEach(() => {
    resetTimeSources();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('keeps each leg’s and each evidence file’s token, re-verifying over what it attests and never changed', async () => {
    const v = await offered();
    const legs = await pool.query<{
      tenant_id: string;
      transaction_id: string;
      sequence_no: number;
      leg_type: string;
      document_id: string;
      content_hash: string;
      prev_leg_hash: string | null;
      tsa_token_digest: string;
      tsa_token: Buffer;
      executed: string;
    }>(
      `select l.tenant_id, l.transaction_id, l.sequence_no, l.leg_type, l.document_id, l.content_hash, l.prev_leg_hash,
              l.tsa_token_digest, l.tsa_token, extract(epoch from l.executed_at)::bigint::text executed
         from core.contract_leg l join core.transaction t on t.id = l.transaction_id
        where t.transaction_ref = $1 order by l.sequence_no`,
      [v.transactionRef],
    );
    expect(legs.rows.length).toBeGreaterThanOrEqual(3);
    const memoryLegs = 'legs' in v.transaction ? v.transaction.legs : [];
    for (const row of legs.rows) {
      expect(createHash('sha256').update(row.tsa_token).digest('hex')).toBe(row.tsa_token_digest);
      const leg = memoryLegs.find((l) => l.sequenceNo === row.sequence_no);
      if (leg === undefined) throw new Error('leg not in the view');
      const attested = await authority.verify(new Uint8Array(row.tsa_token), legAnchorDigest(leg));
      expect(attested?.genTimeEpochSeconds.toString()).toBe(row.executed);
    }

    const evidence = await pool.query<{ captured_tsa_digest: string; captured_tsa_token: Buffer | null; hash: string }>(
      `select e.captured_tsa_digest, e.captured_tsa_token, e.artefact_hash hash
         from evidence.evidence e join core.transaction t on t.id = e.transaction_id
        where t.transaction_ref = $1 and e.evidence_type = 'DELIVERY_NOTE'`,
      [v.transactionRef],
    );
    expect(evidence.rows.length).toBeGreaterThan(0);
    for (const row of evidence.rows) {
      const token = row.captured_tsa_token;
      if (token === null) throw new Error('no token kept');
      expect(createHash('sha256').update(token).digest('hex')).toBe(row.captured_tsa_digest);
      expect(await authority.verify(new Uint8Array(token), row.hash)).toBeDefined();
    }

    // Neither the token nor its digest can be changed afterwards, even by the owner.
    const attempt = (column: string) =>
      pool
        .query(
          `update evidence.evidence e set ${column} = ${column === 'captured_tsa_token' ? "'\\x00'::bytea" : "'x'"}
             from core.transaction t where t.id = e.transaction_id and t.transaction_ref = $1`,
          [v.transactionRef],
        )
        .then(
          () => 'changed',
          (e: { message: string }) => e.message,
        );
    expect(await attempt('captured_tsa_token')).toMatch(/immutable/);
    expect(await attempt('captured_tsa_digest')).toMatch(/immutable/);
    // One whole transaction to the sale offer, against a database other suites share.
  }, 60_000);
});
