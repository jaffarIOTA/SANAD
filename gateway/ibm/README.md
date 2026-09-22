# IBM DataPower Gateway

**Confirmed as the production gateway.** The bank runs DataPower on Red Hat
OpenShift Container Platform, on the bank's own instance. We do not host it, do
not operate it and do not pay for it. What we supply is an API definition and
the policy obligations below, which the bank's DataPower team implements.

That has three consequences worth stating plainly:

- **Kong is a lower-environment tool only.** Development and sandbox, open
  source, effectively free. It is not a production dependency and never will
  be. `../kong/kong.yaml` stays the reference declaration of what the gateway
  must do, because it is executable and reviewable; DataPower reproduces it.
- **The licence question is settled.** Neither Kong Enterprise nor Kong Konnect
  is needed for production, because there is no production Kong.
- **The hosting question is largely settled too.** If our services run on the
  bank's OpenShift alongside DataPower, the Azure region timing is far less
  critical than it looked. See the open question at the bottom.

## The obligations

Everything in `../kong/kong.yaml`, which is deliberately small.

| Concern | Kong | DataPower |
|---|---|---|
| Route `/origination/v1` to the service | service + route | API Gateway / MPGW with a matching rule |
| TLS only, no plaintext listener | `protocols: [https]` | front-side handler, TLS server profile |
| mTLS | terminated at the load balancer | DataPower terminates it; this is what DataPower is good at |
| Request body cap, 1 MB | `request-size-limiting` | `parse` action, maximum message size |
| Coarse rate limit | `rate-limiting` | rate limit / assembly policy |
| `X-Correlation-Id` generated when absent, echoed | `correlation-id` | assembly `set-variable` |
| No browser origins | `cors`, empty origins | omit any CORS policy |
| **No gateway retries** | `retries: 0` | invoke policy, retry count 0 |

### The retry row is the one to check first

A gateway retry reissues a request **without a fresh `Idempotency-Key`**. That
is the one path by which this platform can execute an instruction twice — a
duplicate purchase leg, or a duplicate payment.

The service protects itself: a replayed key returns the stored response rather
than executing. But that relies on the retry carrying the *same* key, which a
gateway-level retry does, and on the store being durable, which it is not yet.
Do not rely on it. **Confirm the invoke policy's retry count is zero**, and get
it in writing, because it is an easy default to leave on.

## What DataPower must NOT do

This section is longer than it was for Kong, and deliberately so. **DataPower is
a transformation engine.** GatewayScript, XSLT and JSON/XML mediation are its
core competency and the first thing an experienced DataPower team reaches for.
Every item below is something DataPower does *well*, which is exactly why it
has to be ruled out explicitly rather than assumed absent.

- **No body transformation, in either direction.** A gateway that can rewrite a
  body can change an amount. There is no GatewayScript, XSLT or map policy on
  this API's request or response path. If a transformation appears necessary,
  the contract is wrong and the contract gets changed — in
  `api/openapi/origination.v1.yaml`, under review.

- **No JSON normalisation, no schema coercion, no field stripping.** The API's
  schemas are closed: an unknown property is refused, and that refusal is how a
  rate-shaped field cannot be posted (SH-01). A gateway that helpfully strips
  unknown fields before forwarding **silently disables that control** and the
  service would never see the field it is supposed to reject.

- **No error rewriting.** DataPower's default is to replace an upstream error
  with its own fault format. Our errors are RFC 9457 problem details carrying a
  control code and bilingual text; a compliance rejection that loses its
  control code becomes a generic decline, which §6 and §8 both forbid. **4xx
  and 5xx bodies from the service pass through byte-for-byte.**

- **Authentication is not the system of record.** The service authenticates
  every request itself and derives tenant, channel and partner from the
  credential. A DataPower policy that authenticates is defence in depth and
  never the only check. It must not strip or replace the `Authorization`
  header.

- **No entitlement, authorisation or Shariah control.** There is no
  configuration in any gateway product that may advance a transaction past an
  unsatisfied sequencing gate, and none should be written that appears to.

## Configuration lives in git

DataPower v10 on OpenShift is deployed through the DataPower Operator, with a
`DataPowerService` custom resource and configuration in ConfigMaps. IBM
supports a GitOps flow over exactly that.

Use it. The rule from `../README.md` applies unchanged: **this directory is
authoritative and configuration is applied from it**, not exported out of a
WebGUI. Note that the WebGUI is not generally available on OpenShift
deployments anyway, which helps.

## Acceptance

The gateway is correctly configured when:

1. `test/contract/service.test.ts` passes against the service **directly**, and
2. the same suite passes against the service **through DataPower**, unchanged.

Both, with no modification to either the service or the tests. Two assertions
in that suite are the ones that will catch a well-intentioned DataPower policy:
the unknown-property refusal, which a normalising gateway would break, and the
problem-detail control code, which an error-rewriting gateway would strip.

## Open question

**Is the OpenShift cluster on-premises, or Azure Red Hat OpenShift?** It
matters: an on-premises in-Kingdom cluster removes the Azure region timing
problem entirely, while ARO puts it straight back, because ARO runs in an Azure
region and there is no in-Kingdom one until November 2026. Recorded as E-15.
