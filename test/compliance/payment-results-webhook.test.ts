/**
 * The partner bank's payment status report (UAE M5b, SR-016). Each case
 * attempts a forged, altered, replayed or misdirected delivery and passes
 * only when it records nothing; a delivery signed with the tenant's own
 * secret records the result. The tenant is the one whose secret verified the
 * signature — a body naming another is not read.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signWebhook } from '../../adapters/kernel/webhook-signature.ts';
import { getApplication, listApplications, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import { POST } from '../../apps/ops/src/app/api/business/v1/webhooks/payment-results/[tenant]/route.ts';

const SECRET = 'test-webhook-secret-for-payment-results-0123456789';
const TENANT = 'sme-fund-ae';
let id = '';

beforeAll(() => {
  process.env['SANAD_CREDENTIAL_PAYMENTS_HUB_SANDBOX_WEBHOOK_SECRET'] = SECRET;
});

beforeEach(async () => {
  resetBusinessStore();
  const paid = (await listApplications(TENANT)).find((v) => v.application.status === 'DISBURSED');
  id = paid?.application.applicationId ?? '';
  expect(id).not.toBe('');
});

const now = () => BigInt(Math.floor(Date.now() / 1000));
const deliver = (body: unknown, opts: { secret?: string; header?: string | null; tenant?: string } = {}) => {
  const raw = JSON.stringify(body);
  const header =
    opts.header === undefined ? signWebhook(new TextEncoder().encode(opts.secret ?? SECRET), raw, now()) : opts.header;
  const request = new Request('https://ops.example/api/business/v1/webhooks/payment-results/x', {
    method: 'POST',
    body: raw,
    headers: header === null ? {} : { 'Sanad-Signature': header },
  });
  return POST(request, { params: Promise.resolve({ tenant: opts.tenant ?? TENANT }) });
};
const settled = () => ({ applicationId: id, idempotencyKey: `business:${id}:disburse`, status: 'SETTLED', instructionRef: 'pb-1' });
const trancheStatus = async () => (await getApplication(TENANT, id))?.closing.tranches?.[0]?.status;

describe('payment status reports', () => {
  it('records a delivery signed with the tenant’s secret, once', async () => {
    const body = settled();
    const raw = JSON.stringify(body);
    const header = signWebhook(new TextEncoder().encode(SECRET), raw, now());
    expect((await deliver(body, { header })).status).toBe(204);
    expect(await trancheStatus()).toBe('SETTLED');
    // The same signed delivery again is a replay.
    expect((await deliver(body, { header })).status).toBe(401);
  });

  it('records nothing unsigned, signed with another secret, or altered after signing', async () => {
    expect((await deliver(settled(), { header: null })).status).toBe(401);
    expect((await deliver(settled(), { secret: 'test-another-secret-entirely-0123456789' })).status).toBe(401);
    const raw = JSON.stringify(settled());
    const header = signWebhook(new TextEncoder().encode(SECRET), raw, now());
    const altered = new Request('https://ops.example/x', {
      method: 'POST',
      body: raw.replace('SETTLED', 'REJECTED'),
      headers: { 'Sanad-Signature': header },
    });
    expect((await POST(altered, { params: Promise.resolve({ tenant: TENANT }) })).status).toBe(401);
    expect(await trancheStatus()).toBe('RELEASED');
  });

  it('an unknown tenant, an unknown instruction or a malformed status is refused', async () => {
    expect((await deliver(settled(), { tenant: 'no-such-tenant' })).status).toBe(404);
    expect((await deliver({ ...settled(), idempotencyKey: 'business:other:disburse' })).status).toBe(404);
    expect((await deliver({ ...settled(), status: 'PAID' })).status).toBe(400);
    expect(await trancheStatus()).toBe('RELEASED');
  });
});
