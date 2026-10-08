/**
 * The revision functions against a real database (migration 0009): the
 * trigger and constraints hold the same rules as core/config/revision.ts,
 * and every proposal and decision lands in the hash-chained audit table.
 * Runs only when SANAD_TEST_DATABASE_URL is set.
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env['SANAD_TEST_DATABASE_URL'];

describe.skipIf(url === undefined)('configuration revisions in the database (SANAD_TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const tenant = async (): Promise<string> =>
    (await pool.query<{ id: string }>("select id from core.tenant where code = 'fintech-b'")).rows[0]?.id ?? '';
  const cor = '00000000-0000-4000-8000-00000000c0de';
  let id = '';
  afterAll(async () => {
    await pool.end();
  });

  it('proposes, refuses self-approval, and is not effective while proposed', async () => {
    const t = await tenant();
    id =
      (
        await pool.query<{ id: string }>(
          "select config.propose_revision($1::uuid, 'PARTNERS', '{\"probe\": true}'::jsonb, 'contract probe', now() + interval '1 hour', 'adm-contract-01', $2::uuid) as id",
          [t, cor],
        )
      ).rows[0]?.id ?? '';
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      pool.query("select config.decide_revision($1::uuid, 'adm-contract-01', true, null, $2::uuid)", [id, cor]),
    ).rejects.toThrow(/FOUR_EYES/);
    // Earlier runs leave approved rows behind (they are immutable), so the assertion is about this revision, not the count.
    const eff = await pool.query<{ id: string }>(
      "select id from config.effective_revision($1::uuid, 'PARTNERS', now() + interval '2 hours')",
      [t],
    );
    expect(eff.rows[0]?.id).not.toBe(id);
  });
  it('approved by another it is effective from its moment; before that moment it is not', async () => {
    const t = await tenant();
    await pool.query("select config.decide_revision($1::uuid, 'adm-contract-02', true, null, $2::uuid)", [id, cor]);
    expect(
      (await pool.query<{ id: string }>("select id from config.effective_revision($1::uuid, 'PARTNERS', now())", [t]))
        .rows[0]?.id,
    ).not.toBe(id);
    expect(
      (
        await pool.query<{ id: string }>(
          "select id from config.effective_revision($1::uuid, 'PARTNERS', now() + interval '2 hours')",
          [t],
        )
      ).rows[0]?.id,
    ).toBe(id);
  });
  it('is immutable once decided: no edit, no delete, no second decision', async () => {
    await expect(pool.query("update config.revision set summary = 'x' where id = $1::uuid", [id])).rejects.toThrow(
      /immutable/,
    );
    await expect(pool.query('delete from config.revision where id = $1::uuid', [id])).rejects.toThrow(/never deleted/);
    await expect(
      pool.query("select config.decide_revision($1::uuid, 'adm-contract-03', false, 'late', $2::uuid)", [id, cor]),
    ).rejects.toThrow(/already APPROVED/);
  });
  it('wrote a chained audit event for the proposal and the decision', async () => {
    const rows = (
      await pool.query<{ event_type: string; prev_hash: string | null; content_hash: string }>(
        'select event_type, prev_hash, content_hash from audit.audit_event where subject_id = $1::uuid order by id',
        [id],
      )
    ).rows;
    expect(rows.map((r) => r.event_type)).toEqual(['REVISION_PROPOSED', 'REVISION_APPROVED']);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.content_hash);
  });
});
