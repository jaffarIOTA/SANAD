/**
 * Nothing lost, nothing duplicated (CLAUDE.md §2, §11).
 *
 * Each case attempts a lost or doubled side effect and passes only when the
 * outbox prevents it: a retry after a lost acknowledgement carries the same
 * key; a refusal is never retried; exhausted attempts go dead for a person,
 * not away; two enqueues of one effect are one row.
 */
import { describe, expect, it } from 'vitest';

import { dispatchOnce, backoffSeconds } from '@sanad/core/outbox/dispatch.ts';
import { type OutboxEvent } from '@sanad/core/outbox/outbox.ts';
import { inMemoryOutboxStore, runOutboxPass } from '@sanad/core/outbox/store.ts';
import { type DevelopmentDelivery, developmentDispatchPorts } from '../../services/outbox/src/development-ports.ts';

const policy = { maxAttempts: 3, backoffSeconds: 300 };
const event = (over: Partial<OutboxEvent> = {}): OutboxEvent => ({
  eventId: 'txn-1:disburse',
  tenantId: 'bank-a',
  kind: 'PAYMENT_DISBURSE',
  subjectRef: 'txn-1',
  idempotencyKey: 'txn-1:disburse',
  payload: { beneficiaryRef: 'app-1', minorUnits: '5000000', currency: 'SAR' },
  correlationId: 'c',
  ...over,
});

describe('dispatch outcomes', () => {
  it('delivers every kind through its port with the event’s own idempotency key', async () => {
    const ledger: DevelopmentDelivery[] = [];
    const ports = developmentDispatchPorts(ledger);
    const events: OutboxEvent[] = [
      event(),
      event({
        eventId: 'e2',
        kind: 'PAYMENT_COLLECT',
        idempotencyKey: 'k2',
        payload: { payerRef: 'app-1', minorUnits: '100', currency: 'SAR' },
      }),
      event({
        eventId: 'e3',
        kind: 'BUREAU_REPORT',
        idempotencyKey: 'k3',
        payload: { facilityRef: 'txn-1', event: 'OPENED', minorUnits: '5000000' },
      }),
      event({
        eventId: 'e4',
        kind: 'PARTNER_CALLBACK',
        idempotencyKey: 'k4',
        payload: { partnerRef: 'agg-1', webhook: 'requestStateChanged', state: 'APPROVED' },
      }),
      event({
        eventId: 'e5',
        kind: 'NOTIFICATION',
        idempotencyKey: 'k5',
        payload: { recipientKind: 'COUNTERPARTY', recipientRef: 'cp-1', event: 'REQUEST_APPROVED', channels: 'SMS' },
      }),
      event({
        eventId: 'e6',
        kind: 'BILL_PRESENT',
        idempotencyKey: 'k6',
        payload: { payerRef: 'app-1', minorUnits: '888488', dueDateGregorian: '2026-11-01' },
      }),
    ];
    for (const e of events) expect((await dispatchOnce(e, ports, policy, 1)).kind).toBe('DELIVERED');
    expect(ledger.map((l) => l.idempotencyKey)).toEqual(['txn-1:disburse', 'k2', 'k3', 'k4', 'k5', 'k6']);
  });
  it('an unavailable rail is retried with the tenant’s backoff, then goes dead — never dropped, never duplicated', async () => {
    const ledger: DevelopmentDelivery[] = [];
    const ports = developmentDispatchPorts(ledger, { unavailable: new Set(['payments']) });
    const first = await dispatchOnce(event(), ports, policy, 1);
    expect(first).toMatchObject({ kind: 'RETRY', afterSeconds: 300 });
    expect(await dispatchOnce(event(), ports, policy, 2)).toMatchObject({ kind: 'RETRY', afterSeconds: 600 });
    expect((await dispatchOnce(event(), ports, policy, 3)).kind).toBe('DEAD');
    expect(ledger).toHaveLength(0);
    expect(backoffSeconds(policy, 20)).toBe(86_400);
  });
  it('a refusal by the rail is dead at once: retrying a refused payment is how a second payment happens', async () => {
    const ports = developmentDispatchPorts([]);
    ports.payments.disburse = () =>
      Promise.resolve({ ok: true as const, value: { kind: 'REFUSED' as const, code: 'BENEFICIARY_UNKNOWN' } });
    expect(await dispatchOnce(event(), ports, policy, 1)).toMatchObject({
      kind: 'DEAD',
      reason: 'refused: BENEFICIARY_UNKNOWN',
    });
  });
  it('a payload that cannot be mapped is dead, not guessed', async () => {
    expect(
      (await dispatchOnce(event({ payload: { beneficiaryRef: 'x' } }), developmentDispatchPorts([]), policy, 1)).kind,
    ).toBe('DEAD');
  });
});

describe('the store and a worker pass', () => {
  it('two enqueues of one effect are one row; a pass delivers once; a later pass finds nothing due', async () => {
    const store = inMemoryOutboxStore();
    await store.append([event(), event()]);
    expect(await store.rows()).toHaveLength(1);
    const ledger: DevelopmentDelivery[] = [];
    const ports = developmentDispatchPorts(ledger);
    const first = await runOutboxPass(store, (e, attempt) => dispatchOnce(e, ports, policy, attempt), 1_000n);
    expect(first).toEqual([{ eventId: 'txn-1:disburse', kind: 'PAYMENT_DISBURSE', outcome: 'DELIVERED' }]);
    const second = await runOutboxPass(store, (e, attempt) => dispatchOnce(e, ports, policy, attempt), 2_000n);
    expect(second).toEqual([]);
    expect(ledger).toHaveLength(1);
    expect((await store.rows())[0]).toMatchObject({ state: 'DELIVERED', attempts: 1 });
  });
  it('a retry is not due until its backoff has passed, and a leased row is not claimed twice', async () => {
    const store = inMemoryOutboxStore();
    await store.append([event()]);
    const ports = developmentDispatchPorts([], { unavailable: new Set(['payments']) });
    await runOutboxPass(store, (e, attempt) => dispatchOnce(e, ports, policy, attempt), 1_000n);
    expect(await runOutboxPass(store, (e, attempt) => dispatchOnce(e, ports, policy, attempt), 1_100n)).toEqual([]);
    expect((await store.rows())[0]).toMatchObject({ state: 'PENDING', attempts: 1, nextAttemptAtEpochSeconds: 1_300n });
    const claimedTwice = await Promise.all([store.claim(1_300n, 10, 60), store.claim(1_300n, 10, 60)]);
    expect(claimedTwice[0].length + claimedTwice[1].length).toBe(1);
  });
});
