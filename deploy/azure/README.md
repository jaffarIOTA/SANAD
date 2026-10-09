# Azure — hosted environment, Phase 1

Plan and reasoning: `docs/AZURE-DEPLOYMENT-PLAN.md`. **Synthetic data only.** The database is
the Supabase project (ADR 0004). Real customer data needs Phase 2 and the go-live gate.

| | |
|---|---|
| Subscription | IOTA Subscription (`7641d14b-8094-4ed2-bc4b-dfe49932da2e`) |
| Resource group | `rg-sanad-hosted`, UAE North |
| Registry | `acrsanadhsqwsz4ds5xmo.azurecr.io` (`sanad-consumer`, `sanad-ops`, `sanad-admin`) |
| Key Vault | `kv-sanad-hsqwsz4d` (Premium, RBAC, purge protection) |
| Container Apps | `ca-sanad-consumer`, `ca-sanad-ops`, `ca-sanad-admin` in `cae-sanad` |
| Deploy identity | `id-sanad-deploy`, federated to GitHub environment `production` |
| Runtime identity | `id-sanad-apps`: AcrPull, Key Vault Secrets User |

## Hostnames

| App | Hostname | Exposure |
|---|---|---|
| consumer | `sanad.iotatechnologies.io` | Public |
| ops | `ops.sanad.iotatechnologies.io` | Public, staff sign-in |
| admin | `admin.sanad.iotatechnologies.io` | Only the CIDRs in `adminAllowedCidrs` |

## Secrets in Key Vault

Values are never in this repository, the template or a log. Each is read by `id-sanad-apps`
as a Container Apps Key Vault reference.

| Secret | Read by | Source |
|---|---|---|
| `ops-session-secret`, `admin-session-secret`, `consumer-session-secret` | each app | 32 random bytes, generated in place |
| `sanad-database-url` | all three | the Supabase connection string |

Rotate a session secret: set a new version, then restart the app's revision (every session is
signed out). Never print a value: `az keyvault secret set --value "$(openssl rand -hex 32)" -o none`.

## Deploying a release

1. Merge `main` into `prod` by pull request (the security gates must pass).
2. Tag the merge commit on `prod`: `git tag v2026.10.09-1 origin/prod && git push origin v2026.10.09-1`.
3. `.github/workflows/deploy-azure.yml` builds, scans with Trivy, pushes and rolls out each app.
   A tag whose commit is not on `prod` is refused.

## Changing the infrastructure

```sh
az deployment group what-if -g rg-sanad-hosted -f deploy/azure/main.bicep \
  -p deployApps=true imageTag=<tag> adminAllowedCidrs='["<cidr>"]' deployerObjectId=<object id>
az deployment group create  ... (same parameters)
```

First build from scratch: run with `deployApps=false`, set the four secrets, build the images
(`az acr build -r <registry> -f apps/Containerfile --build-arg APP=<app> -t sanad-<app>:<tag> --platform linux/amd64 .`),
then run with `deployApps=true`.

## Custom domains

For each hostname, the DNS zone needs a `CNAME` to the app's default FQDN and a `TXT`
record `asuid.<host>` holding the environment's verification ID. Then:

```sh
az containerapp hostname add  -g rg-sanad-hosted -n ca-sanad-<app> --hostname <host>
az containerapp hostname bind -g rg-sanad-hosted -n ca-sanad-<app> --hostname <host> \
  --environment cae-sanad --validation-method CNAME
```

`bind` issues and renews a free managed certificate. The apex-style name
`sanad.iotatechnologies.io` is itself a subdomain of `iotatechnologies.io`, so a CNAME works for it.

## Known limits of Phase 1

- One replica per app, because some stores are still in memory.
- No staff sign-in in production until OIDC (`OIDC with Entra ID`) lands; development tokens are
  refused when `NODE_ENV=production`.
- The origination API service and the outbox worker are not deployed; both still wire
  development stand-ins (SR-004).
- Key Vault and the registry accept public network traffic; private endpoints are Phase 2.
