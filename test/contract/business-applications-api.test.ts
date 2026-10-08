/**
 * The business-application hand-over, against its contract.
 *
 * The document side: both operations exist in `api/openapi/origination.v1.yaml`
 * with the conventions every other operation keeps (Idempotency-Key, problem
 * details, closed schemas, no tenant and no currency in the body). The other
 * side: the workbench's route handlers, called directly with a development
 * upstream credential, in memory. Those run only without a database — with one
 * configured the hand-over writes rows that by design can never be deleted,
 * so they are not written by a test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';

const SPEC = parse(readFileSync(fileURLToPath(new URL('../../api/openapi/origination.v1.yaml', import.meta.url)), 'utf8')) as Record<string, any>;
const schemas = SPEC['components']['schemas'] as Record<string, any>;

describe('the contract declares the hand-over', () => {
  const post = SPEC['paths']['/business-applications']?.['post'];
  const get = SPEC['paths']['/business-applications/{applicationId}']?.['get'];

  it('has both operations', () => {
    expect(post?.operationId).toBe('handOverBusinessApplication');
    expect(get?.operationId).toBe('getBusinessApplication');
  });

  it('requires an Idempotency-Key on the hand-over', () => {
    const refs = (post.parameters as { $ref?: string }[]).map((p) => p.$ref);
    expect(refs).toContain('#/components/parameters/IdempotencyKey');
  });

  it('answers 201 on creation and 200 on a repeat of the same upstream reference', () => {
    expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(['201', '200', '400', '401', '403', '409', '422']));
  });

  it('carries no tenant and no currency in the body, and closes every new schema', () => {
    const body = schemas['BusinessHandover'];
    expect(Object.keys(body.properties)).not.toContain('tenantId');
    expect(Object.keys(body.properties)).not.toContain('currency');
    for (const name of ['BusinessHandover', 'BusinessApplicant', 'BusinessOwner', 'BusinessContact', 'BusinessApplicationStatus']) {
      expect(schemas[name]?.additionalProperties, name).toBe(false);
    }
  });

  it('carries the amount as a digit string of minor units', () => {
    expect(schemas['BusinessHandover'].properties.requestedMinorUnits.type).toBe('string');
    expect(schemas['BusinessApplicationStatus'].properties.requestedMinorUnits.type).toBe('string');
  });

  it('reports the stages Sanad owns, 5 to 9', () => {
    const stage = schemas['BusinessApplicationStatus'].properties.stage;
    expect([stage.minimum, stage.maximum]).toEqual([5, 9]);
  });
});

const DATABASE = process.env['SANAD_DATABASE_URL'] ?? process.env['SANAD_TEST_DATABASE_URL'];
const TOKEN = 'test-token-upstream-record-contract';

describe.skipIf(DATABASE !== undefined)('the hand-over route, in memory', () => {
  let POST: (r: Request) => Promise<Response>;
  let GET: (r: Request, c: { params: Promise<{ applicationId: string }> }) => Promise<Response>;

  beforeAll(async () => {
    process.env['UPSTREAM_RECORD_DEV_TOKEN'] = TOKEN;
    process.env['SANAD_JURISDICTION'] = 'AE';
    const business = await import('../../apps/ops/src/server/business.ts');
    business.resetBusinessStore({ seed: false });
    ({ POST } = await import('../../apps/ops/src/app/api/origination/v1/business-applications/route.ts'));
    ({ GET } = await import('../../apps/ops/src/app/api/origination/v1/business-applications/[applicationId]/route.ts'));
  });

  const body = (over: Record<string, unknown> = {}) => JSON.stringify({
    applicationId: 'FR-00007001',
    upstreamRef: 'upstream-contract-7001',
    applicant: {
      businessNameEn: 'Contract Test Trading LLC', registrationRef: 'TL-CONTRACT-7001', sector: 'TRADING', yearsInOperation: 4,
      owners: [{ displayName: 'Contract Owner Example', ref: 'owner-contract-7001' }], upstreamVerificationRefs: ['uaepass:assert-contract'],
    },
    productCode: 'sme-term-conventional', variantCode: 'SMALL_LOAN', purpose: 'INVENTORY', requestedMinorUnits: '25000000', tenorMonths: 24,
    ...over,
  });
  const post = (payload: string, key = crypto.randomUUID(), token = TOKEN) => POST(new Request('http://ops.test/api/origination/v1/business-applications', {
    method: 'POST', body: payload, headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' },
  }));

  it('refuses an unknown credential with 401', async () => {
    expect((await post(body(), crypto.randomUUID(), 'not-a-credential')).status).toBe(401);
  });

  it('refuses a request without an Idempotency-Key', async () => {
    const r = await POST(new Request('http://ops.test/x', { method: 'POST', body: body(), headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(r.status).toBe(400);
  });

  it('refuses a currency in the body as an unknown property', async () => {
    const r = await post(body({ currency: 'AED' }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { reason: string }).reason).toBe('UNKNOWN_PROPERTY');
  });

  it('refuses an identity number with a named control, bilingually', async () => {
    const r = await post(body({ upstreamRef: 'upstream-contract-id', applicationId: 'FR-00007009', applicant: {
      businessNameEn: 'X', registrationRef: 'TL-X', sector: 'TRADING', yearsInOperation: 1, owners: [{ displayName: 'Y', ref: '784-1990-1234567-1' }], upstreamVerificationRefs: ['u:1'],
    } }));
    expect(r.status).toBe(422);
    const p = (await r.json()) as { reason: string; control: string; detailAr: string };
    expect(p.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
    expect(p.control).toBe('OP-DETERMINACY');
    expect(p.detailAr.length).toBeGreaterThan(0);
  });

  it('#14 refuses an identity number in the contact or the upstream reference, not only the applicant', async () => {
    const inContact = await post(body({ applicationId: 'FR-00007010', upstreamRef: 'upstream-contract-7010', contact: { partyRef: '784-1990-1234567-1' } }));
    expect(inContact.status).toBe(422);
    expect(((await inContact.json()) as { reason: string }).reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
    const inUpstream = await post(body({ applicationId: 'FR-00007011', upstreamRef: 'cif-784199012345671' }));
    expect(inUpstream.status).toBe(422);
    expect(((await inUpstream.json()) as { reason: string }).reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
    // Nothing was created for either.
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    for (const applicationId of ['FR-00007010', 'FR-00007011']) {
      expect((await GET(new Request('http://ops.test/x', auth), { params: Promise.resolve({ applicationId }) })).status).toBe(404);
    }
  });

  it('creates with 201, in the tenant’s currency, and is idempotent on the upstream reference', async () => {
    const key = crypto.randomUUID();
    const created = await post(body(), key);
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe('/api/origination/v1/business-applications/FR-00007001');
    const wire = (await created.json()) as Record<string, unknown>;
    expect(wire).toMatchObject({ applicationId: 'FR-00007001', status: 'RECEIVED', stage: 5, requestedMinorUnits: '25000000', currency: 'AED' });

    const replay = await post(body(), key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replay')).toBe('true');

    const again = await post(body());
    expect(again.status).toBe(200);
    expect(((await again.json()) as { applicationId: string }).applicationId).toBe('FR-00007001');

    const reused = await post(body({ applicationId: 'FR-00007002' }));
    expect(reused.status).toBe(422);
    expect(((await reused.json()) as { reason: string }).reason).toBe('UPSTREAM_REF_REUSED');
  });

  it('reads the status back, and reports an unknown id as absent', async () => {
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    const found = await GET(new Request('http://ops.test/x', auth), { params: Promise.resolve({ applicationId: 'FR-00007001' }) });
    expect(found.status).toBe(200);
    expect(((await found.json()) as { stage: number }).stage).toBe(5);
    const absent = await GET(new Request('http://ops.test/x', auth), { params: Promise.resolve({ applicationId: 'FR-00000000' }) });
    expect(absent.status).toBe(404);
  });
});
