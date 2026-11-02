/**
 * Wasl W6b-1 on PostgreSQL — Shariah incidents (migration 0034).
 *
 * An incident is raised once and never changed; its steps are rows written
 * once, in order, and closed by a different reviewer from the one who
 * remediated. Each case also tries the tables directly, as an operator with a
 * database connection would, and passes only when the database refuses:
 *
 *   - the same finding raised twice; an incident rewritten or deleted;
 *   - a step out of order, a step taken twice, a step rewritten or deleted;
 *   - a closure by the remediator, or with income still to purify;
 *   - one tenant reading another's incidents.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';

import {
  type Discovery,
  actOnIncident,
  raiseIncident,
  shariahIncidents,
} from '../../services/origination/src/shariah/incidents.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-8);
const T = 'bank-a';

let clock = Date.UTC(2026, 9, 26, 6, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

let n = 0;
const discovery = (): Discovery => {
  n += 1;
  return {
    subjectRef: `WT-DB${RUN.slice(-4)}`,
    productCode: 'murabaha-scf',
    checkCode: 'TEMPLATE_DRIFT',
    control: 'SH-17',
    reason: 'DOCUMENT_DIFFERS_FROM_TEMPLATE',
    context: { legType: 'PURCHASE', run: `${RUN}-${String(n)}` },
    severity: 'MATERIAL',
  };
};

describe.skipIf(url === undefined)('Shariah incidents on PostgreSQL (Wasl W6b-1)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(() => {
    vi.stubEnv('SANAD_DATABASE_URL', url ?? '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const refused = (sql: string, values: readonly unknown[]) =>
    pool.query(sql, [...values]).then(
      () => undefined,
      (x: unknown) => x as { code?: string; constraint?: string },
    );

  it('raises a finding once, and the incident row is never rewritten', async () => {
    const d = discovery();
    const raised = expectOk(await raiseIncident(T, 'system:shariah-review', d));
    expect(raised?.incidentRef).toMatch(/^SI-\d{6}$/);
    expect(expectOk(await raiseIncident(T, 'system:shariah-review', d))).toBeUndefined();
    const id = raised?.incidentId;
    for (const sql of [
      `update core.shariah_incident set severity = 'LOW' where id = $1::uuid`,
      `delete from core.shariah_incident where id = $1::uuid`,
    ])
      expect(await refused(sql, [id])).toBeDefined();
    const dup = await refused(
      `insert into core.shariah_incident (tenant_id, incident_ref, subject_ref, product_code, check_code, control,
         reason, context, severity, fingerprint, raised_by, raised_at, correlation_id)
       select tenant_id, 'SI-999999', subject_ref, product_code, check_code, control, reason, context, severity,
              fingerprint, raised_by, raised_at, correlation_id from core.shariah_incident where id = $1::uuid`,
      [id],
    );
    expect(dup?.constraint).toBe('shariah_incident_fingerprint_unique');
  });

  it('steps go in order, once each, and the remediator does not close', async () => {
    const raised = expectOk(await raiseIncident(T, 'system:shariah-review', discovery()));
    const si = raised?.incidentRef ?? '';
    const id = raised?.incidentId;
    // Straight to the plan, past the triage: refused by the table.
    const skipped = await refused(
      `insert into core.shariah_incident_event (tenant_id, incident_id, seq, kind, detail, actor, occurred_at,
         correlation_id)
       select tenant_id, id, 2, 'PLAN', '{"plan":"x x x"}'::jsonb, 'stf-shariah-01', now(), gen_random_uuid()
         from core.shariah_incident where id = $1::uuid`,
      [id],
    );
    expect(skipped?.code).toBe('23001');
    const wrongKind = await refused(
      `insert into core.shariah_incident_event (tenant_id, incident_id, seq, kind, detail, actor, occurred_at,
         correlation_id)
       select tenant_id, id, 1, 'CLOSE', '{"closureEvidence":"x x x"}'::jsonb, 'stf-shariah-01', now(), gen_random_uuid()
         from core.shariah_incident where id = $1::uuid`,
      [id],
    );
    expect(wrongKind?.constraint).toBe('shariah_incident_event_in_order');

    for (const action of [
      { kind: 'TRIAGE', severity: 'MATERIAL', owner: 'stf-shariah-01', note: '' },
      { kind: 'PLAN', plan: 'Re-execute the purchase on the approved template' },
      { kind: 'REMEDIATE', note: 'Re-executed', purificationRequired: false },
    ] as const) {
      advance(60);
      expectOk(await actOnIncident(T, 'stf-shariah-01', si, action));
    }
    // The triage again, as a second row: refused.
    const twice = await refused(
      `insert into core.shariah_incident_event (tenant_id, incident_id, seq, kind, detail, actor, occurred_at,
         correlation_id)
       select tenant_id, incident_id, seq, kind, detail, actor, occurred_at, correlation_id
         from core.shariah_incident_event where incident_id = $1::uuid and seq = 1`,
      [id],
    );
    expect(twice?.constraint).toBe('shariah_incident_event_once');
    // Closed by the remediator, directly: refused by the trigger.
    const self = await refused(
      `insert into core.shariah_incident_event (tenant_id, incident_id, seq, kind, detail, actor, occurred_at,
         correlation_id)
       select tenant_id, id, 4, 'CLOSE', '{"closureEvidence":"DOC-1"}'::jsonb, 'stf-shariah-01', now(), gen_random_uuid()
         from core.shariah_incident where id = $1::uuid`,
      [id],
    );
    expect(self?.code).toBe('23001');
    for (const sql of [
      `update core.shariah_incident_event set detail = '{}'::jsonb where incident_id = $1::uuid`,
      `delete from core.shariah_incident_event where incident_id = $1::uuid`,
    ])
      expect((await refused(sql, [id]))?.code).toBe('23001');

    advance(60);
    expectOk(await actOnIncident(T, 'stf-shariah-02', si, { kind: 'CLOSE', closureEvidence: 'DOC-1' }));
    expect((await shariahIncidents(T)).find((i) => i.incidentRef === si)).toMatchObject({
      status: 'CLOSED',
      remediatedBy: 'stf-shariah-01',
      closedBy: 'stf-shariah-02',
    });
  });

  it('an incident whose income must be purified is not closed, even directly', async () => {
    const raised = expectOk(await raiseIncident(T, 'system:shariah-review', discovery()));
    const si = raised?.incidentRef ?? '';
    for (const action of [
      { kind: 'TRIAGE', severity: 'MATERIAL', owner: 'stf-shariah-01', note: '' },
      { kind: 'PLAN', plan: 'Purify the profit' },
      { kind: 'REMEDIATE', note: 'Defective sale', purificationRequired: true },
    ] as const) {
      advance(60);
      expectOk(await actOnIncident(T, 'stf-shariah-01', si, action));
    }
    const direct = await refused(
      `insert into core.shariah_incident_event (tenant_id, incident_id, seq, kind, detail, actor, occurred_at,
         correlation_id)
       select tenant_id, id, 4, 'CLOSE', '{"closureEvidence":"DOC-2"}'::jsonb, 'stf-shariah-02', now(), gen_random_uuid()
         from core.shariah_incident where id = $1::uuid`,
      [raised?.incidentId],
    );
    expect(direct?.code).toBe('23001');
  });

  it('one tenant never reads another’s incidents', async () => {
    const seen = await inTenant(pool, await tenantUuidByCode(pool, 'fintech-b'), (db) =>
      db.query<{ n: string }>(`select count(*)::text n from core.shariah_incident where subject_ref = $1`, [
        `WT-DB${RUN.slice(-4)}`,
      ]),
    );
    expect(seen.rows[0]?.n).toBe('0');
  });
});
