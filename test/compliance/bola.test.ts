/**
 * SR-019: an identifier that belongs to another principal is absent, never
 * someone else's to read or act on (broken object-level authorisation).
 *
 * - A checkout session of another merchant: 404, answered exactly as an
 *   identifier that does not exist, and its cancellation refused the same way.
 * - A consumer offer of another applicant: refused as not found, nothing
 *   accepted.
 * - A business application of another tenant: no tenant's lookup or listing
 *   ever reaches another tenant's book. (Through the partner API a second
 *   tenant is refused even earlier: only tenants active under the deployment's
 *   jurisdiction pass, and each credential carries its own.)
 *
 * In memory; the deployment's jurisdiction is pinned rather than read from a
 * configured test database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env['MERCHANT_DEV_TOKEN'] = 'test-token-merchant-bola';
  process.env['CONSUMER_SESSION_SECRET'] = 'e5'.repeat(32);
  process.env['UPSTREAM_RECORD_DEV_TOKEN'] = 'test-token-upstream-bola';
  return { cookies: new Map<string, string>() };
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { url: 'not-found' });
  },
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined),
      set: (name: string, value: string) => {
        state.cookies.set(name, value);
      },
      delete: (name: string) => {
        state.cookies.delete(name);
      },
    }),
}));

const TOKEN = 'test-token-merchant-bola';
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'completed';
  } catch (e) {
    return (e as { url?: string }).url ?? `threw: ${String(e)}`;
  }
};
const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeAll(() => {
  vi.stubEnv('SANAD_TEST_DATABASE_URL', '');
  vi.stubEnv('SANAD_DATABASE_URL', '');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

describe('another merchant’s checkout session is absent (SR-019)', () => {
  const call = (path: string, init: RequestInit = {}) =>
    new Request(`https://pay.sanad.test/api/checkout/v1/sessions${path}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });

  it('answers 404 to read or cancel it, exactly as for an identifier that does not exist', async () => {
    const { POST } = await import('../../apps/consumer/src/app/api/checkout/v1/sessions/route.ts');
    const { GET } = await import('../../apps/consumer/src/app/api/checkout/v1/sessions/[sessionId]/route.ts');
    const { PUT: CANCEL } =
      await import('../../apps/consumer/src/app/api/checkout/v1/sessions/[sessionId]/cancellation/route.ts');
    const store = await import('../../apps/consumer/src/server/checkout-store.ts');

    const created = await POST(
      call('', {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          merchantOrderRef: 'order-bola-1',
          basket: { minorUnits: '150000', currency: 'SAR' },
          returnUrl: 'https://shop.test/return',
          cancelUrl: 'https://shop.test/cancel',
        }),
      }),
    );
    expect(created.status).toBe(201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const ctx = (id: string) => ({ params: Promise.resolve({ sessionId: id }) });

    // Its own merchant reads it.
    expect((await GET(call(`/${sessionId}`), ctx(sessionId))).status).toBe(200);

    // The same session, now belonging to another merchant.
    const session = store.findSession(sessionId);
    expect(session).toBeDefined();
    if (session === undefined) return;
    store.saveSession({ ...session, core: { ...session.core, merchantId: 'mer-another-01' } });

    const shape = async (r: Response) => {
      const { correlationId: _c, ...rest } = (await r.json()) as Record<string, unknown>;
      return { status: r.status, ...rest };
    };
    const theirs = await GET(call(`/${sessionId}`), ctx(sessionId));
    const missing = await GET(call('/cks_does_not_exist'), ctx('cks_does_not_exist'));
    expect(await shape(theirs)).toEqual(await shape(missing));
    expect(theirs.status).toBe(404);

    const cancel = await CANCEL(
      call(`/${sessionId}/cancellation`, {
        method: 'PUT',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: '{}',
      }),
      ctx(sessionId),
    );
    expect(cancel.status).toBe(404);
    expect(store.findSession(sessionId)?.state).toBe(session.state);
  });
});

describe('another applicant’s offer cannot be accepted (SR-019)', () => {
  it('refuses it as not found and records no acceptance', async () => {
    const { quoteFor, TENANT } = await import('../../apps/consumer/src/server/engine.ts');
    const store = await import('../../apps/consumer/src/server/store.ts');
    const { acceptAction, signInAction } = await import('../../apps/consumer/src/server/actions.ts');
    const { expectOk } = await import('../../core/kernel/result.ts');

    const quoted = expectOk(
      quoteFor('tawarruq-personal', 5_000_000n, 12, 'applicant-owner', store.developmentAttestation()),
    );
    const offerId = `ofr_bola_${crypto.randomUUID().slice(0, 8)}`;
    store.saveOffer({
      offerId,
      tenantId: TENANT,
      applicantRef: 'applicant-owner',
      productCode: 'tawarruq-personal',
      offer: quoted.offer,
      maturityDateGregorian: '2027-10-05',
      maturityDateHijri: '1449-05-04',
      expiresAtEpochSeconds: store.developmentAttestation().epochSeconds + 604_800n,
    });

    state.cookies.clear();
    expect(await outcome(signInAction(form({ locale: 'en', applicantRef: 'applicant-intruder' })))).toBe('/en/apply');
    const attempt = await outcome(
      acceptAction(form({ locale: 'en', offerId, confirm: 'yes', disclosureVersion: quoted.offer.disclosureVersion })),
    );
    expect(attempt).toBe('/en/apply?refused=OFFER_NOT_FOUND&control=OP-DETERMINACY');
    expect(store.acceptanceFor(offerId)).toBeUndefined();

    // The owner can: the refusal was about who, not about the offer.
    state.cookies.clear();
    await outcome(signInAction(form({ locale: 'en', applicantRef: 'applicant-owner' })));
    expect(
      await outcome(
        acceptAction(
          form({ locale: 'en', offerId, confirm: 'yes', disclosureVersion: quoted.offer.disclosureVersion }),
        ),
      ),
    ).toBe(`/en/offer/${offerId}/accepted`);
  });
});

describe('another tenant’s business application is absent (SR-019)', () => {
  it('is reached by no other tenant’s lookup or listing', async () => {
    vi.stubEnv('SANAD_JURISDICTION', 'AE');
    const business = await import('../../apps/ops/src/server/business.ts');
    business.resetBusinessStore({ seed: false });
    const applicationId = 'FR-00007301';
    const r = await business.handOver(
      'sme-fund-ae',
      {
        applicationId,
        upstreamRef: 'upstream-bola-7301',
        applicant: {
          businessNameEn: 'Bola Test Trading LLC',
          registrationRef: 'TL-BOLA-7301',
          sector: 'TRADING',
          yearsInOperation: 4,
          owners: [{ displayName: 'Bola Owner Example', ref: 'owner-bola-7301' }],
          upstreamVerificationRefs: ['uaepass:assert-bola'],
        },
        productCode: 'sme-term-conventional',
        variantCode: 'SMALL_LOAN',
        purpose: 'INVENTORY',
        requestedMinorUnits: 25_000_000n,
        tenorMonths: 24,
        graceMonths: 0,
        contributionPerTenThousand: 2_000,
      },
      'upstream',
    );
    expect(r.ok).toBe(true);
    expect(await business.getApplication('sme-fund-ae', applicationId)).toBeDefined();
    for (const other of ['bank-a', 'fintech-b'] as const) {
      expect(await business.getApplication(other, applicationId), other).toBeUndefined();
      expect(
        (await business.listApplications(other)).map((v) => v.application.applicationId),
        other,
      ).not.toContain(applicationId);
    }
  });
});
