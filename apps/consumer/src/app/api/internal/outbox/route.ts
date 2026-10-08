/**
 * Development only: run one dispatcher pass over this process's outbox and
 * show the ledger. In production the worker (services/outbox) does this
 * against the database, and this route does not exist.
 */

import { dispatchOnce } from '@sanad/core/outbox/dispatch.ts';
import { runOutboxPass } from '@sanad/core/outbox/store.ts';
import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

import { outboxStore } from '@/server/checkout-store.ts';
import { syncConsumerStore } from '@/server/durable.ts';
import { developmentAttestation } from '@/server/store.ts';
import {
  type DevelopmentDelivery,
  developmentDispatchPorts,
} from '../../../../../../../services/outbox/src/development-ports.ts';

const ledger: DevelopmentDelivery[] = [];
const ports = developmentDispatchPorts(ledger);

export async function POST(): Promise<Response> {
  if (process.env['NODE_ENV'] === 'production') return new Response(null, { status: 404 });
  // The dispatcher reads the same store the journey writes: the database's when one is configured.
  await syncConsumerStore();
  const policy = expectOk(loadOriginationPolicy('bank-a')).servicingRetry;
  const results = await runOutboxPass(
    outboxStore(),
    (e, attempt) => dispatchOnce(e, ports, policy, attempt),
    developmentAttestation().epochSeconds,
  );
  const rows = (await outboxStore().rows()).map((r) => ({
    eventId: r.event.eventId,
    kind: r.event.kind,
    state: r.state,
    attempts: r.attempts,
    deliveryRef: r.deliveryRef ?? null,
  }));
  return new Response(JSON.stringify({ results, rows, ledger }), { headers: { 'content-type': 'application/json' } });
}
