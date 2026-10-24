/**
 * Servicing S2 — collections and bureau reporting on a disbursed facility in
 * arrears (the seed's FR-00005108, UAE: collected from the confirmed payee
 * account through the partner bank). Each case attempts a doubled or a lost
 * collection and passes only when the service prevents it.
 */
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import { serveFromEnvironmentMap } from '../support/credentials.ts';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  SEED_PRINCIPALS,
  confirmRepayment,
  getApplication,
  presentCollections,
  queuedBusinessNotifications,
  recordCollectionResult,
  recordRepayment,
  reportToBureau,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';
import { signWebhook } from '../../adapters/kernel/webhook-signature.ts';
import { POST } from '../../apps/ops/src/app/api/business/v1/webhooks/collection-results/[tenant]/route.ts';

const TENANT = 'sme-fund-ae' as const;
const ID = 'FR-00005108';
const { finance, checker } = SEED_PRINCIPALS;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

beforeEach(() => resetBusinessStore());

describe('collections', () => {
  it('presents each due or overdue instalment once, from the confirmed payee account', async () => {
    const v = expectOk(await presentCollections(TENANT, ID, finance));
    const presented = v.servicing?.collections ?? [];
    expect(presented.length).toBeGreaterThan(0);
    expect(presented.every((c) => c.channel === 'PARTNER_BANK')).toBe(true);
    const queued = queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'PAYMENT_COLLECT');
    expect(queued.map((e) => e.idempotencyKey)).toEqual(presented.map((c) => c.idempotencyKey));
    expect(queued[0]?.payload['payerIban']).toMatch(/^AE\d{21}$/);
    expect(reason(await presentCollections(TENANT, ID, finance))).toBe('NOTHING_TO_COLLECT');
  });

  it('a paid result is a receipt confirmed by the rail, once; a returned one is presented again under a new key', async () => {
    const v = expectOk(await presentCollections(TENANT, ID, finance));
    const [first, second] = v.servicing?.collections ?? [];
    if (first === undefined) throw new Error('nothing presented');
    const before = v.servicing?.position.arrears.minorUnits ?? 0n;
    const paid = expectOk(
      await recordCollectionResult(
        TENANT,
        ID,
        {
          idempotencyKey: first.idempotencyKey,
          status: 'PAID',
          reference: 'pb-coll-1',
          receivedOn: today(),
          source: 'FIXTURE',
        },
        'partner-bank',
      ),
    );
    expect(paid.servicing?.repayments.at(-1)).toMatchObject({
      channel: 'PARTNER_BANK',
      confirmedBy: 'rail:partner_bank',
    });
    expect(paid.servicing?.position.arrears.minorUnits).toBeLessThan(before);
    const again = expectOk(
      await recordCollectionResult(
        TENANT,
        ID,
        {
          idempotencyKey: first.idempotencyKey,
          status: 'PAID',
          reference: 'pb-coll-1',
          receivedOn: today(),
          source: 'FIXTURE',
        },
        'partner-bank',
      ),
    );
    expect(again.servicing?.repayments).toHaveLength(paid.servicing?.repayments.length ?? 0);
    if (second !== undefined) {
      expectOk(
        await recordCollectionResult(
          TENANT,
          ID,
          {
            idempotencyKey: second.idempotencyKey,
            status: 'RETURNED',
            reference: 'pb-coll-2',
            receivedOn: today(),
            source: 'FIXTURE',
          },
          'partner-bank',
        ),
      );
      const re = expectOk(await presentCollections(TENANT, ID, finance));
      expect(re.servicing?.collections.at(-1)?.idempotencyKey).toBe(`${second.idempotencyKey}:R1`);
    }
  });

  it('reports the month to the bureau once; a facility repaid in full is reported settled once', async () => {
    const v = expectOk(await reportToBureau(TENANT, ID, finance));
    const report = queuedBusinessNotifications().find(
      (e) => e.subjectRef === ID && e.idempotencyKey === `business:${ID}:bureau:${today().slice(0, 7)}`,
    );
    expect(report?.payload).toMatchObject({
      event: (v.servicing?.position.daysPastDue ?? 0) > 0 ? 'ARREARS' : 'INSTALMENT_PAID',
    });
    expect(reason(await reportToBureau(TENANT, ID, finance))).toBe('BUREAU_ALREADY_REPORTED');
    // Pay everything still owed, confirmed by a second person: the bureau hears SETTLED, once.
    const owed = (await getApplication(TENANT, ID))?.servicing?.position.outstandingTotal.minorUnits ?? 0n;
    expect(owed).toBeGreaterThan(0n);
    const rp = expectOk(
      await recordRepayment(
        TENANT,
        ID,
        {
          amountMinorUnits: owed,
          receivedOn: today(),
          reference: 'bank-ref-payoff',
          channel: 'MANUAL',
          source: 'LIVE',
        },
        finance,
      ),
    );
    const settled = expectOk(
      await confirmRepayment(TENANT, ID, rp.servicing?.repayments.at(-1)?.repaymentId ?? '', checker),
    );
    expect(settled.servicing?.position.outstandingTotal.minorUnits).toBe(0n);
    const settledReports = queuedBusinessNotifications().filter(
      (e) => e.subjectRef === ID && e.idempotencyKey === `business:${ID}:bureau:settled`,
    );
    expect(settledReports).toHaveLength(1);
    expect(settledReports[0]?.payload['event']).toBe('SETTLED');
  });
});

describe('the collection-results webhook', () => {
  it('records a signed paid result; refuses an unsigned one', async () => {
    // From an environment map even where a database (and so the vault) is configured: the CI database suite.
    const restore = serveFromEnvironmentMap({
      SANAD_CREDENTIAL_PAYMENTS_HUB_SANDBOX_WEBHOOK_SECRET: 'test-webhook-secret-for-collections-0123456789',
    });
    onTestFinished(restore);
    const v = expectOk(await presentCollections(TENANT, ID, finance));
    const key = v.servicing?.collections[0]?.idempotencyKey ?? '';
    const raw = JSON.stringify({
      applicationId: ID,
      idempotencyKey: key,
      status: 'PAID',
      reference: 'pb-hook-1',
      receivedOn: today(),
    });
    const unsigned = await POST(new Request('https://ops.example/x', { method: 'POST', body: raw }), {
      params: Promise.resolve({ tenant: TENANT }),
    });
    expect(unsigned.status).toBe(401);
    const header = signWebhook(
      new TextEncoder().encode('test-webhook-secret-for-collections-0123456789'),
      raw,
      BigInt(Math.floor(Date.now() / 1000)),
    );
    const signed = await POST(
      new Request('https://ops.example/x', { method: 'POST', body: raw, headers: { 'Sanad-Signature': header } }),
      {
        params: Promise.resolve({ tenant: TENANT }),
      },
    );
    expect(signed.status).toBe(204);
    expect((await getApplication(TENANT, ID))?.servicing?.collections[0]?.result).toBe('PAID');
  });
});
