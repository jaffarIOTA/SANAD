/**
 * SR-018: the review API never shows or touches another institution's request.
 *
 * Each case attempts a cross-tenant read or write through the workbench's review
 * route handlers, called directly with development staff credentials, and passes
 * only when the attempt fails. Another tenant's request is reported absent (404),
 * never forbidden, so the API does not confirm that it exists. In memory only:
 * with a database configured the seeded book is not this process's to read.
 */
import { beforeAll, describe, expect, it } from 'vitest';

const DATABASE = process.env['SANAD_DATABASE_URL'] ?? process.env['SANAD_TEST_DATABASE_URL'];
const BANK_A = 'test-token-review-bank-a-checker';
const SME_FUND = 'test-token-review-sme-fund-officer';
const VIEWS = ['review', 'servicing', 'maker', 'information', 'failures', 'breached', 'decided'];

type Ctx = { params: Promise<{ requestId: string }> };
type Item = { requestId: string };

describe.skipIf(DATABASE !== undefined)('review API tenant isolation (SR-018)', () => {
  let queue: (r: Request) => Promise<Response>;
  let read: (r: Request, c: Ctx) => Promise<Response>;
  let decide: (r: Request, c: Ctx) => Promise<Response>;
  let retry: (r: Request, c: Ctx) => Promise<Response>;
  let bankARequestIds: string[];

  const ctx = (requestId: string): Ctx => ({ params: Promise.resolve({ requestId }) });
  const get = (path: string, token: string) =>
    new Request(`http://ops.test/api/review/v1/${path}`, { headers: { authorization: `Bearer ${token}` } });
  const put = (path: string, token: string, body: unknown) =>
    new Request(`http://ops.test/api/review/v1/${path}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': crypto.randomUUID(),
        'content-type': 'application/json',
      },
    });
  const items = async (r: Response) => ((await r.json()) as { items: Item[] }).items;

  beforeAll(async () => {
    process.env['STAFF_DEV_TOKEN_CHECKER'] = BANK_A;
    process.env['STAFF_DEV_TOKEN_AE_OFFICER'] = SME_FUND;
    ({ GET: queue } = await import('../../apps/ops/src/app/api/review/v1/queue/route.ts'));
    ({ GET: read } = await import('../../apps/ops/src/app/api/review/v1/requests/[requestId]/route.ts'));
    ({ PUT: decide } = await import('../../apps/ops/src/app/api/review/v1/requests/[requestId]/decision/route.ts'));
    ({ PUT: retry } =
      await import('../../apps/ops/src/app/api/review/v1/requests/[requestId]/servicing-retry/route.ts'));
    const seen = new Set<string>();
    for (const view of VIEWS)
      for (const i of await items(await queue(get(`queue?view=${view}`, BANK_A)))) seen.add(i.requestId);
    bankARequestIds = [...seen];
  });

  it('has bank-a requests to attempt against', () => {
    expect(bankARequestIds.length).toBeGreaterThan(0);
  });

  it.each(VIEWS)('shows another tenant an empty %s queue', async (view) => {
    const r = await queue(get(`queue?view=${view}`, SME_FUND));
    expect(r.status).toBe(200);
    expect(await items(r)).toEqual([]);
  });

  it('reports every bank-a request absent to another tenant, and present to its own', async () => {
    for (const id of bankARequestIds) {
      const other = await read(get(`requests/${id}`, SME_FUND), ctx(id));
      expect(other.status, id).toBe(404);
      expect(((await other.json()) as { reason: string }).reason).toBe('REQUEST_NOT_FOUND');
      expect((await read(get(`requests/${id}`, BANK_A), ctx(id))).status, id).toBe(200);
    }
  });

  it('answers a cross-tenant read exactly as it answers a request that does not exist', async () => {
    const missing = await read(get('requests/REQ-DOES-NOT-EXIST', SME_FUND), ctx('REQ-DOES-NOT-EXIST'));
    const id = bankARequestIds[0] as string;
    const other = await read(get(`requests/${id}`, SME_FUND), ctx(id));
    const shape = async (r: Response) => {
      const { correlationId: _, ...rest } = (await r.json()) as Record<string, unknown>;
      return { status: r.status, ...rest };
    };
    expect(await shape(other)).toEqual(await shape(missing));
  });

  it('refuses a cross-tenant decision and servicing retry as not found, changing nothing', async () => {
    for (const id of bankARequestIds) {
      const before = await (await read(get(`requests/${id}`, BANK_A), ctx(id))).json();
      for (const decision of ['APPROVE', 'RETURN', 'REJECT'])
        expect(
          (await decide(put(`requests/${id}/decision`, SME_FUND, { decision, note: 'x', reasonCode: 'x' }), ctx(id)))
            .status,
          `${decision} ${id}`,
        ).toBe(404);
      expect((await retry(put(`requests/${id}/servicing-retry`, SME_FUND, {}), ctx(id))).status, id).toBe(404);
      expect(await (await read(get(`requests/${id}`, BANK_A), ctx(id))).json()).toEqual(before);
    }
  });
});
