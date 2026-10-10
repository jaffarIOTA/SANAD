/**
 * SR-025 in the database: the Shariah parameters change only under four eyes.
 *
 * A BOARD_POSITIONS or STRUCTURES revision proposed by one administrator is not
 * in force until a different one approves it; once in force, a stricter board
 * ruling refuses a structure that no longer meets it. The revisions take effect
 * in 2099 and are read as of 2099, so no other test's present is touched, and
 * each run uses its own values, so a database kept between runs still proves it.
 * Runs with SANAD_TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveBoardPositions, resolveStructure } from '../../services/origination/src/shariah-config.ts';
import { boardFor, structureFor } from '../support/fixtures.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const AS_OF_2099 = BigInt(Date.UTC(2099, 5, 1) / 1000);
const RUN = Math.floor(Math.random() * 100_000);

describe.skipIf(url === undefined)('Shariah parameters under four eyes (SR-025)', () => {
  let pool: Pool;
  let tenants: Record<string, string>;

  const person = (role: string) => `adm-${role}-${randomUUID().slice(0, 6)}`;
  const propose = async (tenant: string, area: string, payload: unknown, by: string) =>
    (
      await pool.query<{ id: string }>(
        `select config.propose_revision($1::uuid, $2, $3::jsonb, 'contract: shariah parameters', timestamptz '2099-01-01', $4, $5::uuid) as id`,
        [tenants[tenant], area, JSON.stringify(payload), by, randomUUID()],
      )
    ).rows[0]?.id as string;
  const approve = (id: string, by: string) =>
    pool.query('select config.decide_revision($1::uuid, $2, true, null, $3::uuid)', [id, by, randomUUID()]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    const { rows } = await pool.query<{ code: string; id: string }>('select code, id::text from core.tenant');
    tenants = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  });
  afterAll(async () => {
    await pool.end();
  });

  it('keeps a proposed board change out of force until a second person approves it', async () => {
    // Above any structure interval, so the board in force refuses the checked-in structure.
    const floor = 400_000 + RUN;
    const proposer = person('maker');
    const id = await propose(
      'fintech-b',
      'BOARD_POSITIONS',
      { ...boardFor('fintech-b'), minimumRiskPeriodSeconds: floor },
      proposer,
    );

    const before = await resolveBoardPositions(pool, 'fintech-b', AS_OF_2099);
    expect(before.ok && before.value.minimumRiskPeriodSeconds).not.toBe(floor);
    // The proposer cannot approve their own change (config.revision_four_eyes).
    await expect(approve(id, proposer)).rejects.toThrow();
    const stillBefore = await resolveBoardPositions(pool, 'fintech-b', AS_OF_2099);
    expect(stillBefore.ok && stillBefore.value.minimumRiskPeriodSeconds).not.toBe(floor);

    await approve(id, person('checker'));
    const after = await resolveBoardPositions(pool, 'fintech-b', AS_OF_2099);
    expect(after.ok && after.value.minimumRiskPeriodSeconds).toBe(floor);

    const structure = await resolveStructure(pool, 'fintech-b', 'MURABAHA_DISTRIBUTOR', AS_OF_2099);
    expect(!structure.ok && structure.error.reason).toBe('RISK_PERIOD_BELOW_BOARD_FLOOR');
  });

  it('keeps a proposed structure change out of force until a second person approves it', async () => {
    const current = structureFor('bank-a');
    const revised = {
      ...current,
      version: 1_000 + RUN,
      gates: current.gates.map((g) => (g.kind === 'ELAPSE' ? { ...g, minimumSeconds: 7_200 } : g)),
    };
    const proposer = person('maker');
    const id = await propose('bank-a', 'STRUCTURES', [revised], proposer);

    const before = await resolveStructure(pool, 'bank-a', 'MURABAHA_DISTRIBUTOR', AS_OF_2099);
    expect(before.ok && before.value.version).not.toBe(revised.version);
    await expect(approve(id, proposer)).rejects.toThrow();

    await approve(id, person('checker'));
    const after = await resolveStructure(pool, 'bank-a', 'MURABAHA_DISTRIBUTOR', AS_OF_2099);
    expect(after.ok && after.value.version).toBe(revised.version);
  });

  it('refuses an area the database does not know', async () => {
    await expect(propose('bank-a', 'SOMETHING_ELSE', {}, person('maker'))).rejects.toThrow();
  });
});
