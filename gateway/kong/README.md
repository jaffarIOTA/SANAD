# Kong

DB-less, open source, applied with [decK](https://docs.konghq.com/deck/).

```bash
# Validate without touching anything
deck gateway validate --state gateway/kong/kong.yaml

# Show what would change
deck gateway diff --state gateway/kong/kong.yaml

# Apply
deck gateway sync --state gateway/kong/kong.yaml
```

`${ORIGINATION_UPSTREAM}` is supplied per environment. It is never written into
the file, so one file serves every environment and no environment's topology
leaks into git.

## Open source, and why that is enough

Kong OSS is Apache 2.0. Kong Enterprise starts around USD 30–50k/year, and the
usual reason teams end up there is that OIDC, SAML and advanced rate limiting
are enterprise-only.

We do not need them, and that falls out of a decision already taken rather than
from luck. CLAUDE.md §5 requires every service to re-validate the caller's
identity independently and never to trust a gateway-injected header. The
gateway is therefore not our authentication authority, so its OIDC plugin is
not load-bearing.

The one enterprise feature we would otherwise want is `mtls-auth`. **Terminate
mTLS at the load balancer in front of Kong** rather than buying a licence for
it. The client certificate is validated before the request reaches the gateway,
and the service re-asserts identity from the bearer credential regardless.

## Hosted control plane (Konnect)

Usable for development and sandbox. Two rules if it is used:

1. **This file stays the source of truth.** Konnect consumes it via `deck
   gateway sync`. Nobody edits in the console — a console edit silently ends
   git's authority and turns a later migration into archaeology.
2. **Nothing Konnect-exclusive goes on the critical path.** The developer
   portal, service catalog and hosted analytics are fine to use and must never
   be depended on.

Note on residency: in hybrid mode the **data planes run wherever you put them**
and payloads never leave them, but the **control plane is outside the Kingdom**
— Konnect's Middle East geo is UAE, and there is no Saudi geo. Configuration
and aggregate telemetry therefore cross the border even though customer data
does not. That is a question for the client's security function, not one for
us to settle. See ClaudeRecommendations.md E-13.

## Rate limiting is coarse here, on purpose

`policy: local` counts per node, so the effective limit is the configured value
multiplied by the number of data planes. That is fine for shedding load and
unfit for anything contractual.

A single cluster-wide limit needs shared counters — Redis, for Kong. See
ClaudeRecommendations.md E-14. Until that is decided, the limit here is
deliberately generous and honest about being approximate, rather than precise
and wrong.
