/**
 * SR-034: in production no app seals a session with a key it made up. With
 * no master secret configured (on Azure, the Key Vault reference missing),
 * Admin, the workbench and the consumer site each refuse to issue a session
 * rather than fall back to an ephemeral one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const SECRETS = ['ADMIN_SESSION_SECRET', 'OPS_SESSION_SECRET', 'CONSUMER_SESSION_SECRET'] as const;
const KEY_CACHES = ['__sanadAdminKey', '__sanadOpsSessionKey', '__sanadConsumerKey'] as const;

describe('production refuses to seal a session without a configured master secret (SR-034)', () => {
  beforeAll(() => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const s of SECRETS) vi.stubEnv(s, '');
    for (const k of KEY_CACHES) delete (globalThis as Record<string, unknown>)[k];
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    for (const k of KEY_CACHES) delete (globalThis as Record<string, unknown>)[k];
  });

  it('Admin', async () => {
    const { startAdminSession } = await import('../../apps/admin/src/server/session.ts');
    await expect(startAdminSession('adm-dev-01')).rejects.toThrow(/master secret is not configured/);
  });

  it('the workbench', async () => {
    const { staffSealKey } = await import('../../apps/ops/src/server/staff-session.ts');
    expect(() => staffSealKey()).toThrow(/master secret is not configured/);
  });

  it('the consumer site', async () => {
    const { startSession } = await import('../../apps/consumer/src/server/session.ts');
    await expect(
      startSession({
        applicantRef: 'applicant-secrets',
        identityAssertionId: 'assert-secrets',
        identityRef: 'idref-secrets',
        authenticatedAtEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
      }),
    ).rejects.toThrow(/master secret is not configured/);
  });
});
