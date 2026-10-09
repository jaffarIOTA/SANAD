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
2. **Apply new migrations first** (`npm run db:push`). The images are built for the schema in the
   same commit; code that expects a migration the database lacks fails every query (for 0018:
   `set local role sanad_app` is refused until the migration grants it).
3. **Apply new app settings** the release introduces. The pipeline swaps images only; it never
   applies `main.bicep`. Set them with `az containerapp update -g rg-sanad-hosted -n ca-sanad-<app>
   --set-env-vars NAME=value`, or run the template (below).
4. Tag the merge commit on `prod`: `git tag v2026.10.09-1 origin/prod && git push origin v2026.10.09-1`.
5. `.github/workflows/deploy-azure.yml` builds, scans with Trivy, pushes and rolls out each app.
   A tag whose commit is not on `prod` is refused.

## Runtime database role

Migration 0018 creates `sanad_runtime`: a LOGIN that bypasses no row-level security, owns
nothing and inherits nothing. Every tenant statement already drops to `sanad_app` with the
tenant set (`services/origination/src/tenant-scope.ts`), so the policies bind whatever the
login. Logging in as `sanad_runtime` instead of `postgres` removes what the owner can still do
outside a scope: read the vault's decrypted secrets, disable triggers, `reset role` (SR-003).

Once, per database (the value never leaves the vault):

```sh
pw="$(openssl rand -hex 24)"
# Through stdin, so the value is not in any process's arguments. Owner connection, trusted shell.
printf "alter role sanad_runtime password '%s';\n" "$pw" | psql "$OWNER_URL" -q
# Supabase session pooler: the user is sanad_runtime.<project ref>
az keyvault secret set --vault-name <vault> -n sanad-database-url -o none \
  --value "postgresql://sanad_runtime.<project ref>:$pw@<pooler host>:5432/postgres?sslmode=require"
unset pw
```

Then restart each app's revision so it reads the new version. Migrations keep running as the
owner (`npm run db:push`). Admin shares this login today; a separate Admin login is SR-046.

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
