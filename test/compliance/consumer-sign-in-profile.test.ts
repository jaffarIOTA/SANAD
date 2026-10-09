/**
 * SR-005: the consumer demonstration sign-in cannot impersonate anyone outside
 * development or a confirmed-synthetic hosted environment.
 *
 * The stand-in authenticates whatever applicant reference is typed. Each case
 * attempts that sign-in under a deployed profile and passes only when it is
 * refused with no session cookie set — unless the process declares synthetic
 * data (SANAD_DATA_CLASS=SYNTHETIC) and the database's deployment profile
 * independently confirms it is not cleared for production data.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env['CONSUMER_SESSION_SECRET'] = 'c3'.repeat(32);
  return {
    cookies: new Map<string, string>(),
    pool: undefined as undefined | { query: () => Promise<{ rows: { production_data_permitted: boolean }[] }> },
  };
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
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
vi.mock('../../apps/consumer/src/server/persistence.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../apps/consumer/src/server/persistence.ts')>()),
  persistencePool: () => state.pool,
}));

const ENV_KEYS = ['NODE_ENV', 'SANAD_DEPLOYMENT_PROFILE', 'SANAD_DATA_CLASS'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const redirectOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { url?: string }).url ?? `threw: ${String(e)}`;
  }
  return 'no redirect';
};
const databaseSaying = (productionDataPermitted: boolean) => ({
  query: () => Promise.resolve({ rows: [{ production_data_permitted: productionDataPermitted }] }),
});
const unreadableDatabase = { query: () => Promise.reject(new Error('relation does not exist')) };

function profile(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

let signInAction: (f: FormData) => Promise<void>;
beforeAll(async () => {
  ({ signInAction } = await import('../../apps/consumer/src/server/actions.ts'));
});
beforeEach(() => {
  state.cookies.clear();
  state.pool = undefined;
});
afterEach(() => {
  profile({});
  Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
});

const attempt = () => redirectOf(signInAction(form({ locale: 'en', applicantRef: 'someone-else' })));
const REFUSED = '/en?refused=IDENTITY_PROVIDER_NOT_CONFIGURED&control=OP-DETERMINACY';

describe('consumer demonstration sign-in under a deployed profile (SR-005)', () => {
  it.each([
    ['NODE_ENV=production, nothing declared', { NODE_ENV: 'production' }, undefined],
    ['SANAD_DEPLOYMENT_PROFILE=DEPLOYED, nothing declared', { SANAD_DEPLOYMENT_PROFILE: 'DEPLOYED' }, undefined],
    [
      'production, the database confirms synthetic, but the process does not declare it',
      { NODE_ENV: 'production' },
      databaseSaying(false),
    ],
    [
      'production, synthetic declared, no database to confirm it',
      { NODE_ENV: 'production', SANAD_DATA_CLASS: 'SYNTHETIC' },
      undefined,
    ],
    [
      'production, synthetic declared, the database is cleared for production data',
      { NODE_ENV: 'production', SANAD_DATA_CLASS: 'SYNTHETIC' },
      databaseSaying(true),
    ],
    [
      'production, synthetic declared, the deployment profile is unreadable',
      { NODE_ENV: 'production', SANAD_DATA_CLASS: 'SYNTHETIC' },
      unreadableDatabase,
    ],
    [
      'production, a data class other than SYNTHETIC',
      { NODE_ENV: 'production', SANAD_DATA_CLASS: 'synthetic' },
      databaseSaying(false),
    ],
  ])('refuses, with no session, when %s', async (_, env, pool) => {
    profile(env);
    state.pool = pool;
    expect(await attempt()).toBe(REFUSED);
    expect(state.cookies.size).toBe(0);
  });

  it('refuses before reading the applicant reference, so a malformed one gets the same answer', async () => {
    profile({ NODE_ENV: 'production' });
    expect(await redirectOf(signInAction(form({ locale: 'en', applicantRef: '!' })))).toBe(REFUSED);
  });

  it('permits it when the process declares synthetic data and the database confirms it', async () => {
    profile({ NODE_ENV: 'production', SANAD_DATA_CLASS: 'SYNTHETIC' });
    state.pool = databaseSaying(false);
    expect(await attempt()).toBe('/en/apply');
    expect(state.cookies.size).toBe(1);
  });

  it('permits it in development', async () => {
    profile({ NODE_ENV: 'test' });
    expect(await attempt()).toBe('/en/apply');
    expect(state.cookies.size).toBe(1);
  });
});
