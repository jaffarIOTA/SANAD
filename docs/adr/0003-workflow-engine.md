# ADR 0003 — Durable workflow engine

| | |
|---|---|
| Status | Accepted |
| Date | 2026-09-26 |
| Decided by | Engineering, under CLAUDE.md §6 ("to be selected in the first week") |

## Context

Two things in Sanad run for hours to days across systems that fail independently:
an origination application (servicing platform round-trips, information requested
from outside, retries within a tenant's policy) and a Murabaha transaction (three
gates, evidence arriving from a registry, a risk-holding interval measured against
an external timestamping authority). Both are modelled today as pure state
machines with an in-memory store and a manual "retry" button. Production needs
something that survives a process restart mid-sequence, retries an external call
under a declared policy, and can be replayed for the audit process.

Constraints that matter:

- **Deployed to the buying institution's own OpenShift, in-Kingdom.** A managed
  cloud workflow service is not an option for the bank deployments.
- **The domain must stay pure.** Gate evaluation and every transition are pure
  functions of (state, evidence, attested instant); that is what makes them
  replayable by the Shariah audit. The workflow engine orchestrates; it must not
  become the place where domain rules live.
- **No vendor name in `core/` or `products/`.** The engine is reached through a port.
- **Node + TypeScript** across the stack.

## Decision

**Temporal**, self-hosted on the institution's OpenShift with PostgreSQL as its
persistence, reached from the domain through `core/ports/workflow.ts`.

- Workflows are thin: they call activities in order and hold the durable timer for
  the risk period. Every activity is one domain transition or one adapter call.
- The domain transition remains a pure function; the activity passes it the
  attested instant it was given. **The workflow's own clock is never a domain
  input.** The risk-period timer *wakes* the workflow; the gate then evaluates
  against the TSA attestation fetched by an activity.
- Retry policies for adapter activities are declared per tenant in
  `config/tenants/<tenant>/origination/policy.json` (`servicingRetry`) and mapped
  onto the activity retry options at worker start. The attempt ledger the engine
  already keeps is written by the activity, so the domain record — not the engine's
  history — is the audit source.
- Workflow histories are retained for the same statutory period as the evidence
  they concern, and are exportable for the Shariah audit.

## Alternatives considered

- **A hand-written outbox + scheduler on PostgreSQL.** Enough for retries, not for
  multi-day timers with exactly-once semantics; we would be rebuilding the hard
  part of a workflow engine.
- **Camunda / Zeebe.** Strong BPMN tooling, JVM-centred; the TypeScript client is
  secondary and the modelling would pull rules into diagrams.
- **AWS Step Functions / Azure Durable Functions.** Managed; cannot be deployed to
  a bank's on-premises OpenShift.
- **Edge functions / cron.** Ruled out in the original design: sequencing spans
  hours to days and needs durability.

## Consequences

- `core/ports/workflow.ts` defines `WorkflowPort` (start, signal, query, durable
  timer) with no vendor vocabulary. The adapter is `adapters/workflow-temporal/`.
- The service processes stop holding in-memory state for anything long-running;
  ADR 0001's PostgreSQL decision covers the store.
- The architecture suite already refuses the vendor name inside `core/` and
  `products/`. That stays.
- A bank whose platform team refuses Temporal gets a second adapter behind the same
  port, not a branch.
