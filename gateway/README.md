# Gateway

**IBM API Connect**, with DataPower as the gateway. The definitions and
policies live here as configuration.

```
gateway/
  ibm/    API Connect API definitions, Products and the assembly
```

## The decision

API Connect is the integration layer for all three flows — partner
integration, bank and vendor integration, and the platform's own APIs. The
bank runs DataPower on its own OpenShift; we run API Connect for development
and for the product's own deployment.

**Kong is gone.** It was carried as the development gateway while the client's
choice was unknown. Once DataPower was confirmed, keeping a Kong configuration
that nothing applies would have been worse than not having one: it rots, it
implies a tested capability that is not tested, and the first person to read it
would reasonably believe it described something real.

## What did NOT go away, and why

Sanad is a product. It runs on our cloud, and on each buying institution's own
on-premises OpenShift, under that institution's policy (see
ClaudeRecommendations.md E-23). The second bank may not run API Connect.

So the *configuration* is API Connect's, and the *independence* stays:

- **No service reads a gateway-injected header.** Not `X-Consumer-*`, not
  `X-Client-*`, nothing. `test/architecture/gateway.test.ts` asserts it.
- **Every service re-validates the caller's identity and tenant
  independently.** `services/origination` authenticates from the
  `Authorization` header against its own credential registry and derives
  tenant, channel and partner from that — never from a header.
- **Contract tests run against the service directly**, never through the
  gateway, so they stay valid whatever fronts it.

That independence is not Kong nostalgia. It is what keeps the licence cost
down — we need no OIDC plugin, because the gateway is not our identity source —
and it is what makes onboarding a second institution a configuration exercise
rather than a fork.

## What the gateway is, and is not, responsible for

| Concern | Where |
|---|---|
| TLS termination, mTLS | DataPower, or the load balancer in front of it |
| Coarse rate limiting, request size caps, CORS | Gateway |
| Routing and traffic management | Gateway |
| Products, Plans, subscriptions, developer portal | API Connect |
| **Authentication as the system of record** | **The service.** The gateway may also check; the service never trusts that it did. |
| **Tenant resolution** | **The service**, from the authenticated principal. |
| **Authorisation, entitlements, any Shariah control** | **The service and the domain.** Never a gateway policy. |

The last row is the important one. A sequencing gate is not a routing rule, and
there is no assembly — in API Connect or anywhere else — that can advance a
transaction past an unsatisfied gate.

## Source of truth

**This directory is authoritative.** Configuration is applied *from* here by
`scripts/apic-publish.sh` or by CI, never exported out of the API Manager
console. The moment someone edits an API in the UI, this repository stops
describing what is deployed and the next publish silently reverts them.

If that has to happen during an incident, follow it with a commit.
