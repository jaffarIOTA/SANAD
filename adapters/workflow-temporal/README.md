# Workflow engine adapter — Temporal (ADR 0003)

**Port:** `core/ports/workflow.ts`. **Status:** `BLOCKED` — built and tested against
the in-memory runner; not yet run against a Temporal server.

## Shape

```
programs/     the orchestration, as pure programs over effects (no I/O, no clock, types only from the domain)
activities.ts the only code that touches the domain: load → one transition with a fresh attestation → save
workflows/    Temporal glue: programs bound to proxied activities, signals, queries and durable timers
adapter.ts    the WorkflowPort (idempotent start, signal, query, cancel)
worker.ts     the worker, assembled from the same ports the services use
in-memory/    the same programs and activities on Map stores and a virtual attested clock
```

The point of the split: the sequence — which step, then which, wait for what — is
tested end to end without a server, and the Temporal-specific file is thin enough to
read in one sitting.

## What the engine is not allowed to decide

- A durable timer wakes the workflow at the end of the risk period. It never
  advances the transaction: the next `evaluateGates` activity fetches a fresh
  attestation from the timestamping authority and the pure domain function decides.
  The test *"the timer is not the clock"* pins this.
- A signal says evidence arrived. Only the next gate evaluation says it counts.
- A `SequenceRefusal` (a domain refusal, a state mismatch) is never retried. A rail
  being down is retried under the tenant's `servicingRetry`, mapped by `retryFor()`.

## Verification item

KSA-WF-TEMPORAL-01 — run the worker against a Temporal dev server
(`temporal server start-dev`), start `murabahaSequence` for a seeded transaction,
deliver the two evidence signals and the offer answer, and confirm the workflow
history shows the durable timer and the post-timer gate evaluation as separate
events. Then the institution's OpenShift deployment with PostgreSQL persistence and
mTLS from the vault.

## Running locally

```
temporal server start-dev
TEMPORAL_ADDRESS=127.0.0.1:7233 TEMPORAL_NAMESPACE=default node --experimental-strip-types adapters/workflow-temporal/worker.ts
```

(The worker entry expects the host to assemble `SequencingPorts` — see
`in-memory/runner.ts` for the development assembly.)
