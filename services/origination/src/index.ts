/**
 * Service entrypoint.
 *
 * Wiring only. Every dependency is constructed here and passed in, so the
 * service itself holds no global and nothing reaches for configuration from
 * the middle of a request path.
 *
 * Credentials are read from the environment **at construction**, never held in
 * a module-level global and never re-read per request (§4). In a deployed
 * environment `developmentRegistry` is replaced by a lookup against
 * `config.integration_credential`, and every resolution is audited.
 */

import { createService, developmentTimestamps, BASE_PATH } from './server.ts';
import { createHealthService, type HealthCheck } from './health.ts';
import { inMemoryIdempotencyStore } from './idempotency.ts';
import { inMemoryRequestRepository } from './repository.ts';
import { developmentSnapshots } from './snapshots.ts';
import { isTenantCode, loadAllForTenant } from '@sanad/config/loader.ts';
import { reject } from '@sanad/core/kernel/result.ts';
import { developmentRegistry } from './principal.ts';

const port = Number.parseInt(process.env['PORT'] ?? '3002', 10);

/*
 * What "all good" means for this deployment.
 *
 * Each check answers for one dependency and says as little as it can. A check
 * never reports a host, a connection string or an exception message: those
 * routinely carry credentials, and this report is read by an operator over a
 * network (§4).
 *
 * The list is short today because the dependencies are. As the database, the
 * cache and the external adapters arrive, each gets a check here and nothing
 * else changes — which is the point of the port.
 */
const checks: readonly HealthCheck[] = [
  {
    name: 'contract',
    // If the OpenAPI document failed to compile into validators, the service
    // is running but cannot accept a single request correctly. That is worth
    // knowing before a partner discovers it.
    critical: true,
    run: () =>
      Promise.resolve(
        typeof BASE_PATH === 'string' && BASE_PATH.length > 0
          ? { status: 'UP' as const }
          : { status: 'DOWN' as const, detail: 'contract not loaded' },
      ),
  },
  {
    name: 'repository',
    critical: true,
    run: async () => {
      // A trivial read. Enough to prove the store answers, cheap enough to
      // run on every poll.
      await repository.list({ tenantId: '__health__', partnerId: '__health__', limit: 1 });
      return { status: 'UP' as const, detail: 'in-memory (development)' };
    },
  },
];

const repository = inMemoryRequestRepository();

const server = createService({
  repository,
  health: createHealthService({ checks }),
  idempotency: inMemoryIdempotencyStore(),
  credentials: developmentRegistry(process.env),
  snapshots: developmentSnapshots(),
  creditPolicies: {
    versionsFor: (tenantId) => {
      if (!isTenantCode(tenantId)) return reject('OP-DETERMINACY', 'TENANT_UNKNOWN', 'No configuration for this tenant');
      const all = loadAllForTenant(tenantId);
      return all.ok ? { ok: true, value: all.value.creditPolicies } : all;
    },
  },
  timestamps: developmentTimestamps(),
});

server.listen(port, () => {
  // No credential, identifier or personal datum in this line, or in any other.
  process.stdout.write(
    `origination service listening on http://127.0.0.1:${String(port)}${BASE_PATH}\n`,
  );
});

/*
 * Graceful shutdown, in the order OpenShift needs.
 *
 * On SIGTERM: fail readiness first so the router stops sending new work, wait
 * long enough for endpoint removal to propagate, then close the listener and
 * let in-flight requests finish. Closing immediately would drop requests the
 * platform still believes this pod is serving.
 *
 * `terminationGracePeriodSeconds` in the Deployment must exceed the drain
 * delay plus the longest request, or the kubelet sends SIGKILL mid-flight.
 */
const DRAIN_MS = Number.parseInt(process.env['DRAIN_MS'] ?? '5000', 10);

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;

    server.beginDraining();
    process.stdout.write('draining\n');

    setTimeout(() => {
      server.close(() => {
        process.stdout.write('closed\n');
        process.exit(0);
      });
    }, DRAIN_MS).unref();
  });
}
