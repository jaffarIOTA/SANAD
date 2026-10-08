/**
 * Merchants and presented documents on PostgreSQL (migration 0012). A
 * merchant's row follows its state and every change is in the audit chain; a
 * closed merchant does not change and no merchant is deleted; one commercial
 * registration is one merchant per tenant. A presented document is appended
 * in the order presented and never edited. Runs only when
 * SANAD_TEST_DATABASE_URL is set.
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { beginOnboarding, close, suspend, verify } from '@sanad/core/merchants/merchant.ts';
import { raise } from '@sanad/core/origination/request.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

import { loadDocuments, saveDocuments, saveRequests } from '../../apps/ops/src/server/persistence.ts';
import { findMerchant, loadMerchants, saveMerchant } from '../../services/origination/src/merchants.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_791_700_000;
const RUN = String(Date.now());
const TENANT = 'fintech-b';
// Ten digits, unique per run, so the one-registration-one-merchant constraint is exercised by this run alone.
const CR = `9${RUN.slice(-9)}`;

describe.skipIf(url === undefined)('merchants on PostgreSQL (SANAD_TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const merchantId = `mer-contract-${RUN}`;
  const core = {
    merchantId,
    tenantId: TENANT,
    commercialRegistration: CR,
    legalNameAr: 'متجر',
    legalNameEn: 'Store',
    categoryCode: 'RETAIL',
    settlementAccountRef: 'hub-ref-contract',
    onboardedBy: 'stf-maker-01',
    correlationId: `cor-${RUN}`,
  };
  const pending = expectOk(beginOnboarding(core, at(T0)));
  const active = expectOk(
    verify(pending, {
      agreementRef: 'AGR-CONTRACT-1',
      registryLookupRef: 'reg-1',
      registryStatus: 'ACTIVE',
      screeningResultRef: 'scr-1',
      screeningOutcome: 'CLEAR',
      activityPermitted: true,
      verifiedBy: 'stf-checker-01',
      verifiedAt: at(T0 + 10),
    }),
  );
  afterAll(async () => {
    await pool.end();
  });

  it('follows the merchant through its states, loading back exactly what the domain holds', async () => {
    await saveMerchant(pool, TENANT, {
      merchant: pending,
      event: 'MERCHANT_ONBOARDING_BEGUN',
      actor: 'stf-maker-01',
      correlationId: 'x',
    });
    expect(await findMerchant(pool, TENANT, merchantId)).toEqual(pending);
    await saveMerchant(pool, TENANT, {
      merchant: active,
      event: 'MERCHANT_VERIFIED',
      actor: 'stf-checker-01',
      correlationId: 'x',
    });
    expect(await findMerchant(pool, TENANT, merchantId)).toEqual(active);
    expect(
      (await loadMerchants(pool, TENANT)).some((m) => m.core.merchantId === merchantId && m.status === 'ACTIVE'),
    ).toBe(true);
    expect(await findMerchant(pool, 'bank-a', merchantId)).toBeUndefined();
  });

  it('writes a chained audit event for each change, naming who made it', async () => {
    const rows = (
      await pool.query<{ event_type: string; actor: string; prev_hash: string | null }>(
        "select event_type, actor, prev_hash from audit.audit_event where subject_type = 'core.merchant' and after_state->>'merchantId' = $1 order by id",
        [merchantId],
      )
    ).rows;
    expect(rows.map((r) => `${r.event_type}:${r.actor}`)).toEqual([
      'MERCHANT_ONBOARDING_BEGUN:stf-maker-01',
      'MERCHANT_VERIFIED:stf-checker-01',
    ]);
    expect(rows[1]?.prev_hash).not.toBeNull();
  });

  it('one commercial registration is one merchant per tenant', async () => {
    const twin = expectOk(beginOnboarding({ ...core, merchantId: `${merchantId}-twin` }, at(T0)));
    await expect(
      saveMerchant(pool, TENANT, {
        merchant: twin,
        event: 'MERCHANT_ONBOARDING_BEGUN',
        actor: 'stf-maker-01',
        correlationId: 'x',
      }),
    ).rejects.toThrow(/merchant_registration_once/);
  });

  it('is never deleted, and once closed it does not change', async () => {
    await expect(pool.query('delete from core.merchant where merchant_id = $1', [merchantId])).rejects.toThrow(
      /never deleted/,
    );
    const suspended = expectOk(suspend(active, 'stf-checker-01', 'chargebacks', at(T0 + 20)));
    await saveMerchant(pool, TENANT, {
      merchant: suspended,
      event: 'MERCHANT_SUSPENDED',
      actor: 'stf-checker-01',
      correlationId: 'x',
    });
    const closed = expectOk(close(suspended, 'stf-checker-01', 'merchant request', at(T0 + 30)));
    await saveMerchant(pool, TENANT, {
      merchant: closed,
      event: 'MERCHANT_CLOSED',
      actor: 'stf-checker-01',
      correlationId: 'x',
    });
    await expect(
      saveMerchant(pool, TENANT, {
        merchant: active,
        event: 'MERCHANT_REINSTATED',
        actor: 'stf-checker-01',
        correlationId: 'x',
      }),
    ).rejects.toThrow(/closed and does not change/);
    expect((await findMerchant(pool, TENANT, merchantId))?.status).toBe('CLOSED');
  });
});

describe.skipIf(url === undefined)('presented documents on PostgreSQL (SANAD_TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const requestId = `req_docs_${RUN}`;
  afterAll(async () => {
    await pool.end();
  });

  it('appends in the order presented, loads back the attested capture time, and refuses any edit', async () => {
    const request = expectOk(
      raise({
        core: {
          requestId,
          tenantId: TENANT,
          programmeId: 'prg-0001',
          counterpartyId: 'Example Co.',
          channel: 'MAKER_CHECKER',
          tradeReference: { type: 'PURCHASE_ORDER', issuerCr: '1010000002', recipientCr: '7001000001' },
          requestedAmount: money(1_000_000n),
          requestedTenorDays: 60,
          raisedAt: at(T0),
          identification: { kind: 'STAFF_PRINCIPAL', principalId: 'stf-maker-01' },
          correlationId: `cor-${RUN}`,
        },
        maker: { principalId: 'stf-maker-01', tenantId: TENANT },
        policy: expectOk(loadOriginationPolicy(TENANT)),
      }),
    );
    await saveRequests(pool, TENANT, [{ requestId, request }]);
    const first = {
      requestId,
      position: 0,
      document: { documentType: 'COMMERCIAL_REGISTRATION', capturedAt: at(T0 + 1), validationStatus: 'VALID' as const },
    };
    const second = {
      requestId,
      position: 1,
      document: { documentType: 'AUDITED_FINANCIALS', capturedAt: at(T0 + 2), validationStatus: 'PENDING' as const },
    };
    await saveDocuments(pool, TENANT, [first, second], 'stf-maker-01');
    // Saving the same position again changes nothing: the first capture stands.
    await saveDocuments(
      pool,
      TENANT,
      [{ ...first, document: { ...first.document, documentType: 'SOMETHING_ELSE' } }],
      'stf-maker-01',
    );
    const loaded = (await loadDocuments(pool, TENANT)).filter((d) => d.requestId === requestId);
    expect(loaded).toEqual([first, second]);
    await expect(
      pool.query("update evidence.presented_document set validation_status = 'INVALID' where request_id = $1", [
        requestId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('delete from evidence.presented_document where request_id = $1', [requestId]),
    ).rejects.toThrow(/append-only/);
  });

  it('a document cannot be presented against a request that does not exist', async () => {
    await expect(
      saveDocuments(
        pool,
        TENANT,
        [
          {
            requestId: 'req_missing',
            position: 0,
            document: { documentType: 'X', capturedAt: at(T0), validationStatus: 'VALID' },
          },
        ],
        'stf-maker-01',
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
