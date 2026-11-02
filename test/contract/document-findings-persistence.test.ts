/**
 * Document intelligence D1 on PostgreSQL (migration 0029): findings are kept
 * in `evidence.document_finding`, tenant-scoped and append-only — a finding
 * is never edited or deleted, even by the owner; reading a document again is
 * a new row, and the latest is the one shown. Another tenant sees none.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';

import { findingsFor, readPresentedDocument } from '../../services/origination/src/documents/findings.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-9);
const sha = (n: number) => `${RUN.padStart(9, '0')}${String(n).padStart(55, '0')}`;
const LICENCE = new TextEncoder().encode(
  '%PDF-1.7\nTrade License\nLicense No 778899001\nIssue Date: 2025-01-10 Expiry Date: 09/01/2027\n%%EOF',
);

describe.skipIf(url === undefined)('document findings on PostgreSQL (D1)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const read = (subjectRef: string, n: number) =>
    readPresentedDocument(
      'sme-fund-ae',
      { kind: 'BUSINESS_APPLICATION', ref: subjectRef },
      {
        documentRef: `obj:${subjectRef}/${sha(n)}`,
        declaredType: 'TRADE_LICENCE',
        sha256Hex: sha(n),
        mediaType: 'application/pdf',
        bytes: LICENCE,
      },
      {},
      { ...process.env, SANAD_DATABASE_URL: url },
    );

  it('keeps a finding, reads it back, and a second reading is a new row with the latest shown', async () => {
    const ref = `FR-W${RUN}`;
    expectOk(await read(ref, 1));
    expectOk(await read(ref, 1));
    const rows = await pool.query<{ n: string }>(
      `select count(*)::text n from evidence.document_finding where subject_ref = $1`,
      [ref],
    );
    expect(rows.rows[0]?.n).toBe('2');
    const latest = (
      await findingsFor(
        'sme-fund-ae',
        { kind: 'BUSINESS_APPLICATION', ref },
        { ...process.env, SANAD_DATABASE_URL: url },
      )
    ).get(sha(1));
    expect(latest).toMatchObject({
      classification: { status: 'RECOGNISED', kind: 'TRADE_LICENCE' },
      checks: [{ check: 'TYPE_MATCHES_DECLARED', outcome: 'PASS' }],
      source: 'FIXTURE',
    });
    // Nothing written on the page beyond the dates: not the licence number.
    const raw = await pool.query<{ t: string }>(
      `select (classification::text || facts::text || checks::text) t from evidence.document_finding where subject_ref = $1`,
      [ref],
    );
    for (const r of raw.rows) expect(r.t).not.toContain('778899001');
  });

  it('a finding is never edited or deleted, even by the owner', async () => {
    const ref = `FR-X${RUN}`;
    expectOk(await read(ref, 2));
    for (const sql of [
      `update evidence.document_finding set checks = '[]'::jsonb where subject_ref = $1`,
      `delete from evidence.document_finding where subject_ref = $1`,
    ]) {
      const e = await pool.query(sql, [ref]).then(
        () => undefined,
        (x: unknown) => x as { code?: string },
      );
      expect(e?.code, sql).toBe('23001');
    }
  });

  it('another tenant sees none of them', async () => {
    const ref = `FR-Y${RUN}`;
    expectOk(await read(ref, 3));
    const other = await tenantUuidByCode(pool, 'bank-a');
    const seen = await inTenant(pool, other, (db) =>
      db.query<{ n: string }>(`select count(*)::text n from evidence.document_finding where subject_ref = $1`, [ref]),
    );
    expect(seen.rows[0]?.n).toBe('0');
  });
});
