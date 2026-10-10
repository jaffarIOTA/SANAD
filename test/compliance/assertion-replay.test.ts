/**
 * SR-007: an identity assertion is accepted once, fresh, for its own tenant.
 *
 * Through the Nafath adapter (UAE Pass shares the same check in the adapter
 * base): a second confirmation of the same assertion is a replay; an assertion
 * older than the step-up window, or dated in the future beyond clock skew, is
 * refused; so is one for another tenant, and every confirmation when no replay
 * guard is configured. The database's guard is tested in
 * test/contract/assertion-replay-postgres.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { FixtureTransport } from '../../adapters/kernel/fixture-transport.ts';
import type { RailAdapterConfig } from '../../adapters/ksa/kernel/rail-adapter.ts';
import { NafathAdapter } from '../../adapters/ksa/nafath/adapter.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { type AssertionReplayGuard, inMemoryAssertionReplayGuard } from '../../core/ports/assertion-replay.ts';
import { type CredentialProvider, SecretValue } from '../../core/ports/credentials.ts';
import type { IdentityAuthenticationPort } from '../../core/ports/identity-authentication.ts';

const NOW = 1_800_000_000;

class Credentials implements CredentialProvider {
  get(): Promise<SecretValue> {
    return Promise.resolve(new SecretValue('a-provider-credential-value'));
  }
}
const config = (guard: AssertionReplayGuard | undefined, maxAge?: number): RailAdapterConfig => ({
  tenantId: 'bank-a',
  provider: 'IDENTITY_AUTHENTICATION',
  environment: 'sandbox',
  freshnessWindowSeconds: 0,
  failurePosture: 'FAIL_CLOSED',
  credentialTtlSeconds: 600,
  breaker: { failureThreshold: 5, resetAfterSeconds: 30, successThreshold: 1 },
  nowEpochSeconds: () => NOW,
  baseUrl: 'https://rail.sandbox.example',
  ...(guard === undefined ? {} : { assertionReplay: guard }),
  ...(maxAge === undefined ? {} : { maxAssertionAgeSeconds: maxAge }),
});
const nafath = (guard: AssertionReplayGuard | undefined, completedAt: number, assertionId = 'asr-1', maxAge?: number) =>
  new NafathAdapter(
    config(guard, maxAge),
    new Credentials(),
    new FixtureTransport([
      {
        operation: 'identity.confirm',
        match: {},
        response: { status: 'COMPLETED', assertionId, subjectRef: 'sub-1', completedAt },
      },
    ]),
  ) as IdentityAuthenticationPort;
const confirm = async (port: IdentityAuthenticationPort, tenantId = 'bank-a') =>
  expectOk(await port.confirmAuthentication({ tenantId, transactionRef: 'tx-1', correlationId: 'c' }));

describe('an identity assertion is accepted once, fresh, for its tenant (SR-007)', () => {
  it('accepts it the first time and refuses the replay', async () => {
    const guard = inMemoryAssertionReplayGuard();
    expect((await confirm(nafath(guard, NOW - 10))).kind).toBe('ANSWERED');
    expect(await confirm(nafath(guard, NOW - 10))).toEqual({ kind: 'REFUSED', code: 'ASSERTION_REPLAYED' });
    // Another assertion is its own.
    expect((await confirm(nafath(guard, NOW - 10, 'asr-2'))).kind).toBe('ANSWERED');
  });

  it('refuses an assertion older than the step-up window', async () => {
    const guard = inMemoryAssertionReplayGuard();
    expect(await confirm(nafath(guard, NOW - 301))).toEqual({ kind: 'REFUSED', code: 'ASSERTION_STALE' });
    expect((await confirm(nafath(guard, NOW - 300, 'asr-edge'))).kind).toBe('ANSWERED');
    expect(await confirm(nafath(guard, NOW - 61, 'asr-tight', 60))).toEqual({
      kind: 'REFUSED',
      code: 'ASSERTION_STALE',
    });
  });

  it('refuses one dated beyond clock skew in the future', async () => {
    expect(await confirm(nafath(inMemoryAssertionReplayGuard(), NOW + 121))).toEqual({
      kind: 'REFUSED',
      code: 'ASSERTION_FROM_FUTURE',
    });
  });

  it('refuses one for a tenant other than the adapter’s', async () => {
    expect(await confirm(nafath(inMemoryAssertionReplayGuard(), NOW), 'fintech-b')).toEqual({
      kind: 'REFUSED',
      code: 'TENANT_MISMATCH',
    });
  });

  it('refuses every confirmation when no replay guard is configured', async () => {
    expect(await confirm(nafath(undefined, NOW))).toEqual({ kind: 'REFUSED', code: 'ASSERTION_REPLAY_UNCHECKABLE' });
  });

  it('does not consume an assertion it refused for staleness', async () => {
    const guard = inMemoryAssertionReplayGuard();
    await confirm(nafath(guard, NOW - 1_000, 'asr-late'));
    expect(await guard.consume({ tenantId: 'bank-a', assertionId: 'asr-late', authenticatedAtEpochSeconds: 1n })).toBe(
      'FRESH',
    );
  });
});
