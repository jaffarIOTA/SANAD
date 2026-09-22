# The API Connect instance

What we know about the development instance, and what is still missing. Kept
here rather than in a chat log because it is needed at publish time and at
every environment after this one.

**Nothing in this file is a credential.** Names, versions and endpoints only.

## Confirmed

| | |
|---|---|
| Product | IBM API Connect **v10.0.11.0** (toolkit built 2026-08-22, `darwin/amd64`) |
| Deployment | **Managed SaaS on IBM Cloud**, zone `ap-south-a` (Asia-Pacific South) |
| Platform API | `api.ap-south-a.apiconnect.ibmappdomain.cloud` |
| Provider org | `iota-api-dev` |
| Catalog | **`sandbox`** — inferred from the "Sandbox Catalog User Registry" |
| Provider identity | **IBM Verify**, OIDC, shared. Realm name `ibm-verify` |
| Consumer identity | Sandbox Catalog User Registry, local |
| OpenAPI support | **3.0 and 2.0 only.** 3.1 is rejected outright — see ClaudeRecommendations.md E-25 |

## What the identity provider means for login

**IBM Verify is OIDC**, so interactive login is browser-based:

```sh
apic login --server <platform-api> --realm provider/<realm> --sso
```

**The realm is `provider/ibm-verify`**, taken from the registry's `Name`
field in API Manager → Resources → User registries → IBM Verify. So:

```sh
apic login \
  --server api.ap-south-a.apiconnect.ibmappdomain.cloud \
  --realm provider/ibm-verify \
  --sso
```

`apic identity-providers:list --server <platform-api> --fields realm --scope
provider` prints the same thing and needs no login, but it is currently
blocked by the platform API 403. The UI is the way round that.

### What is NOT needed from that page

The registry's detail page also shows **client information — a client ID and a
client secret**. Those are API Connect's own OAuth registration with IBM
Verify. They are consumed by API Connect, not by us: the toolkit authenticates
with the realm name plus either a browser SSO flow or an API key, and never
sees them.

Do not copy them anywhere. Not into a config file, not into a ticket, not into
a chat. They are the credential that lets something act as API Connect against
your identity provider.

**OIDC does not work in CI**, because there is no browser. Two options for the
pipeline, in order of preference:

1. `apic iam-apikey` — built for an IBM Cloud instance and an IBM Cloud API
   key. Most likely the right one here.
2. `apic login --apiKey` with a toolkit API key from API Manager → My Account.

`.github/workflows/gateway.yml` currently uses option 2 and should be switched
to option 1 if that is what the instance expects.

## Still missing

- **Gateway service type** — *DataPower API Gateway* or *DataPower Gateway
  (v5 compatible)*. They have **different policy sets**, so the assembly in
  `health-api_1.0.0.yaml` depends on it; it currently targets
  `datapower-api-gateway`. Not visible under the provider org's Resources,
  which is normal for SaaS — it is IBM-managed and lives in Cloud Manager.
- **Whether the Developer Portal is enabled** on the sandbox catalog.
- **TLS profiles** available for the invoke to upstream.

## Blocked — and the evidence narrows it considerably

The platform API returns `403 {"Error":"Plan limit reached"}`.

| Probe | Result | What it rules out |
|---|---|---|
| `GET /api/cloud`, **no credential** | `403 Plan limit reached` | Not authentication, not permissions — it answers before any identity is read |
| `GET /definitely/not/a/real/path` | **`404`** | Routing works and the service is up; it distinguishes real paths from bogus ones |
| Response headers | `x-envoy-upstream-service-time: 2` | An upstream answered in 2 ms. Nothing is down or timing out |
| API Manager UI | works normally | Different path, different entitlement |
| Account created | **today**, ~19:26 UTC | — |
| Total users | 1 | — |

**A brand-new account cannot have exhausted a quota.** "Plan limit reached" on
an account hours old with no prior usage is not consumed capacity; it is an
entitlement that has not been applied, or a plan tier that does not include
platform API access at all. Some trial tiers are UI-only.

So there are two candidates, and they need different actions:

1. **Provisioning has not finished propagating.** Common in the first hours
   after an account is created. This resolves by waiting, and costs nothing to
   test — re-run `sh scripts/apic-publish.sh`, which probes before doing
   anything.
2. **The plan does not include Platform API / toolkit access.** Then no amount
   of waiting helps and the plan needs changing.

### For the support ticket

> Account `20260922-1926-5593-809a-cbc498188fce`, instance `iota-api-dev`,
> region `ap-south-a`. The platform API at
> `api.ap-south-a.apiconnect.ibmappdomain.cloud` returns
> `403 {"Error":"Plan limit reached"}` on every valid path **including
> unauthenticated requests**, while a non-existent path correctly returns 404
> and the API Manager UI functions normally. The account was created the same
> day and has no usage. Please confirm whether the plan includes platform API
> access and whether entitlement provisioning has completed.

## Two realms, do not confuse them

| | |
|---|---|
| `www.ibm.com` | The **IBM Cloud account** realm, on the Access Management page |
| `provider/ibm-verify` | The **API Connect provider org** realm, for `apic login` |

The second is the one the toolkit needs.

## Reachability, once it does clear

The health API's `upstream-url` points at
`http://origination.sanad.svc.cluster.local`. A SaaS gateway in Asia-Pacific
cannot reach a service on a laptop, so the first successful publish will answer
`503 {"status":"UNAVAILABLE"}` from the assembly's catch block.

**That is the correct result and a useful one.** It proves toolkit, catalog,
gateway, routing and TLS all work, and that only the network path to the
upstream is missing. A genuine `200` waits for the service and the gateway to
sit in the same cluster, which is the on-premises deployment (E-15). Do not
spend effort tunnelling a laptop to Asia-Pacific to turn a correct `503` into a
`200` that proves nothing more.
