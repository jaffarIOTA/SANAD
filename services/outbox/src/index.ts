/**
 * The outbox worker. Polls the store, dispatches what is due through the
 * ports, records each outcome. One process per deployment is enough; two
 * are safe, because claims are leased.
 *
 * Store: PostgreSQL when DATABASE_URL is set (migration 0008), otherwise in
 * memory — which is only useful in the same process as the thing enqueuing,
 * so the in-memory case is for tests and the workbench. Ports: development
 * ports until each adapter has made its live call.
 */

import { loadOriginationPolicy, isTenantCode } from '../../../config/loader.ts';
import { dispatchOnce } from '../../../core/outbox/dispatch.ts';
import { inMemoryOutboxStore, runOutboxPass } from '../../../core/outbox/store.ts';
import { type DevelopmentDelivery, developmentDispatchPorts } from './development-ports.ts';
import { postgresOutboxStore } from './postgres-store.ts';

const databaseUrl = process.env['DATABASE_URL'];
const store =
  databaseUrl !== undefined && databaseUrl.trim().length > 0
    ? postgresOutboxStore({ connectionString: databaseUrl })
    : inMemoryOutboxStore();
const ledger: DevelopmentDelivery[] = [];
const ports = developmentDispatchPorts(ledger);
const intervalMs = Number.parseInt(process.env['OUTBOX_POLL_MS'] ?? '5000', 10);

function policyFor(tenantId: string) {
  const fallback = { maxAttempts: 3, backoffSeconds: 300 };
  if (!isTenantCode(tenantId)) return fallback;
  const p = loadOriginationPolicy(tenantId);
  return p.ok ? p.value.servicingRetry : fallback;
}

async function pass(): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const results = await runOutboxPass(
    store,
    (event, attempt) => dispatchOnce(event, ports, policyFor(event.tenantId), attempt),
    now,
  );
  // No payload, no reference to a person: kind, outcome and the event id only.
  for (const r of results) process.stdout.write(`outbox ${r.kind} ${r.eventId} ${r.outcome}\n`);
}

process.stdout.write(
  `outbox worker: ${databaseUrl ? 'postgresql' : 'in-memory (development only)'} store, polling every ${String(intervalMs)}ms\n`,
);
const timer = setInterval(() => {
  void pass();
}, intervalMs);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
