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
import { inMemoryIdempotencyStore } from './idempotency.ts';
import { inMemoryRequestRepository } from './repository.ts';
import { developmentRegistry } from './principal.ts';

const port = Number.parseInt(process.env['PORT'] ?? '3002', 10);

const server = createService({
  repository: inMemoryRequestRepository(),
  idempotency: inMemoryIdempotencyStore(),
  credentials: developmentRegistry(process.env),
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
