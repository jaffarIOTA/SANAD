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

## Blocked

The platform API returns `403 {"Error":"Plan limit reached"}` **on every path,
including unauthenticated ones**. The UI works; the platform API does not.
Since those take different paths, the instance is not broken — this looks like
an entitlement on the management API rather than consumed quota.

Nothing can be published until that clears. It is an IBM Cloud console check
(Plan / Usage) and, failing that, a support ticket.

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
