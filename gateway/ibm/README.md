# IBM API Connect / DataPower

**Nothing is configured here yet, and that is the current honest state.**

This directory exists because the client may deploy behind IBM API Connect or
DataPower — common in Saudi banks — and an empty directory with a list of
obligations is more useful than no directory at all. Without it, the first
person who needs rate limiting reaches for middleware inside a service, and the
swap stops being possible.

## What has to be reproduced

Everything in `../kong/kong.yaml`, which is deliberately small:

| Concern | Kong | IBM equivalent |
|---|---|---|
| Route `/origination/v1` to the service | service + route | API definition + assembly |
| TLS only, no plaintext listener | `protocols: [https]` | TLS profile |
| mTLS | terminated at the load balancer | DataPower is usually the terminator |
| Request body cap, 1 MB | `request-size-limiting` | `parse` action limit |
| Coarse rate limit | `rate-limiting` | rate limit / assembly policy |
| `X-Correlation-Id` generated when absent, echoed | `correlation-id` | assembly `set-variable` |
| No browser origins | `cors` with empty origins | omit the CORS policy |
| **No gateway retries** | `retries: 0` | invoke policy retry disabled |

That last row matters more than its size suggests. A gateway retry reissues a
request **without a fresh idempotency key**, which is the one way this platform
can execute an instruction twice. Whichever gateway is in front, retries belong
to the caller.

## What must NOT be reproduced

- **Authentication as the system of record.** The service authenticates every
  request itself. A DataPower policy that authenticates is defence in depth and
  never the only check.
- **Tenant resolution.** Derived from the authenticated principal inside the
  service, never from a header the gateway sets.
- **Any entitlement, authorisation or Shariah control.** There is no gateway
  configuration in any product that may advance a transaction past an
  unsatisfied sequencing gate, and none should be written that appears to.

## Acceptance

The swap is done when the contract suite passes against the service **through**
this gateway with no change to the service, and `test/contract/service.test.ts`
still passes against the service **directly**. Both, unchanged. That is the
whole test.
