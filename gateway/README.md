# Gateway

Gateway concerns — authentication, rate limiting, routing, mTLS, request size,
CORS — declared as configuration, one directory per implementation.

```
gateway/
  kong/   Kong Gateway, DB-less, applied with decK
  ibm/    IBM API Connect / DataPower
```

## Why this directory exists

Kong is the gateway today. The client may deploy behind **IBM API Connect /
DataPower**, which is common in Saudi banks. Swapping one for the other must be
a configuration exercise, not a code change (CLAUDE.md §5).

That only stays true if nothing in the application depends on a particular
gateway having run. So:

- **No service reads a gateway-injected header.** Not `X-Consumer-*`, not
  `X-Authenticated-Scope`, nothing. `test/contract/service.test.ts` asserts
  that forged consumer headers change nothing.
- **Every service re-validates the caller's identity and tenant
  independently.** `services/origination` authenticates from the `Authorization`
  header against its own credential registry and derives tenant, channel and
  partner from that.
- **Contract tests run against the service directly**, never through the
  gateway, so they stay valid across a gateway change.

## What the gateway is, and is not, responsible for

The distinction matters, because it is what keeps the licence cost down and the
implementations interchangeable.

| Concern | Where |
|---|---|
| TLS termination, mTLS | Gateway or the load balancer in front of it |
| Coarse rate limiting, request size caps, CORS | Gateway |
| Routing and traffic management | Gateway |
| **Authentication as the system of record** | **The service.** The gateway may also check; the service never trusts that it did. |
| **Tenant resolution** | **The service**, from the authenticated principal. |
| **Authorisation, entitlements, any Shariah control** | **The service and the domain.** Never a gateway plugin. |

The last row is the important one. A sequencing gate is not a routing rule, and
there is no gateway configuration — in any implementation — that can advance a
transaction past an unsatisfied gate.

## Source of truth

**This directory is authoritative.** Configuration is applied *from* here, never
exported *out* of a running gateway or a hosted control plane's UI. The moment
someone edits in a console, git stops being the source of truth and a gateway
migration becomes an archaeology exercise.

Applies to Kong Konnect as much as to a self-hosted Kong: Konnect consumes this
file, it does not originate it.
