/**
 * Wasl W5b on PostgreSQL (migration 0032): programmes and the board's goods
 * register change only through a revision proposed by one administrator and
 * approved by another, and the configuration Wasl reads is the revision in
 * force — from its effective moment and not before.
 *
 * Revisions here take effect in 2099, so the present every other suite runs
 * in is untouched (as test/contract/shariah-revisions.test.ts does).
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBoardPositions, loadWaslParties, waslProgrammesToJson } from '@sanad/config/loader.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { boardPositionsToJson } from '@sanad/products/murabaha-scf/structures/board-positions.ts';

import { resolveBoard, resolveProgrammes } from '../../services/origination/src/wasl/configuration.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-6);
const AS_OF_2099 = BigInt(Date.UTC(2099, 0, 2) / 1000);

describe.skipIf(url === undefined)('Wasl configuration revisions on PostgreSQL (W5b)', () => {
  let pool: Pool;
  let bankA: string;
  const person = (role: string) => `adm-${role}-${randomUUID().slice(0, 6)}`;
  const propose = async (area: string, payload: unknown, by: string) =>
    (
      await pool.query<{ id: string }>(
        `select config.propose_revision($1::uuid, $2, $3::jsonb, 'contract: wasl configuration', timestamptz '2099-01-01', $4, $5::uuid) as id`,
        [bankA, area, JSON.stringify(payload), by, randomUUID()],
      )
    ).rows[0]?.id as string;
  const approve = (id: string, by: string) =>
    pool.query('select config.decide_revision($1::uuid, $2, true, null, $3::uuid)', [id, by, randomUUID()]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    bankA =
      (await pool.query<{ id: string }>(`select id::text from core.tenant where code = 'bank-a'`)).rows[0]?.id ?? '';
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(() => {
    vi.stubEnv('SANAD_DATABASE_URL', url ?? '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a new programme is in force only once a second person approves it, and only from its moment', async () => {
    const id = `prg-${RUN.slice(-4)}`;
    const programmes = [
      ...waslProgrammesToJson(expectOk(loadWaslParties('bank-a')).programmes),
      {
        programmeId: id,
        nameEn: 'Contract test programme',
        nameAr: 'برنامج اختبار',
        structureCode: 'MURABAHA',
        programmeLimitMinorUnits: '100000000',
        anchor: {
          registrationNo: '1010000555',
          nameEn: 'Contract test anchor',
          nameAr: 'جهة راعية للاختبار',
          settlementIban: 'SA1380000000000000000101',
        },
      },
    ];
    const proposer = person('maker');
    const revision = await propose('PROGRAMMES', programmes, proposer);
    const ids = async (asOf: bigint) =>
      expectOk((await resolveProgrammes('bank-a', asOf)).value).map((p) => p.programmeId);
    expect(await ids(AS_OF_2099)).not.toContain(id);
    // Four eyes, in the database.
    await expect(approve(revision, proposer)).rejects.toThrow();
    await approve(revision, person('checker'));
    const resolved = await resolveProgrammes('bank-a', AS_OF_2099);
    expect(resolved.source).toBe('REVISION');
    expect(await ids(AS_OF_2099)).toContain(id);
    // Not before its effective moment.
    expect(await ids(BigInt(Math.floor(Date.now() / 1000)))).not.toContain(id);
  });

  it('a heading added to the goods register binds from its moment, every other board position as it stood', async () => {
    const board = expectOk(loadBoardPositions('bank-a'));
    const code = `99${RUN.slice(-4)}`;
    const payload = boardPositionsToJson({
      ...board,
      excludedGoods: [...board.excludedGoods, { code, description: 'Contract test heading' }],
    });
    const revision = await propose('BOARD_POSITIONS', payload, person('maker'));
    await approve(revision, person('checker'));
    const after = expectOk((await resolveBoard('bank-a', AS_OF_2099)).value);
    expect(after.excludedGoods.map((g) => g.code)).toContain(code);
    expect(after.lateAmounts).toEqual(board.lateAmounts);
    expect(after.shariahApprovalRef).toBe(board.shariahApprovalRef);
    const now = expectOk((await resolveBoard('bank-a', BigInt(Math.floor(Date.now() / 1000)))).value);
    expect(now.excludedGoods.map((g) => g.code)).not.toContain(code);
  });
});
