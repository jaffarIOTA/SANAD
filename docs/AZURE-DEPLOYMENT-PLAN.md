# Azure deployment plan — sanad.iotatechnologies.io

**Status:** Proposed, for the product owner's approval
**Date:** 2026-10-09
**Owner:** Platform engineering
**Related:** ADR 0001 (residency), ADR 0004 (Supabase for development and UAT), ADR 0005 (two
jurisdictions), ADR 0006 (installation licensing), `docs/SECURITY-REGISTER.md`

## 1. What was decided

| Question | Decision |
|---|---|
| What the hosted environment holds | **Real customer data**, eventually. It is IOTA's own hosted Sanad, for institutions that do not install it themselves |
| Runtime | **Azure Container Apps**, images in Azure Container Registry |
| Database for the first deployment | **The existing Supabase project** |
| Licence enforcement | **Signed licence file, plus optional online check-in** (ADR 0006) |
| On licence expiry | **Grace period, then no new business**; servicing never stops (ADR 0006) |

Two of those decisions cannot hold at once. Supabase has no Saudi or UAE region, and ADR 0004
restricts it to synthetic data. So the plan has two phases, and the line between them is the
first real customer record:

- **Phase 1 — hosted, synthetic.** Container Apps + Supabase, live at
  `sanad.iotatechnologies.io`, synthetic data only. Demonstrations, POCs, UAT.
- **Phase 2 — hosted, real data.** The same apps, in an in-Kingdom Azure region, on Azure
  Database for PostgreSQL and Key Vault (managed HSM). Real customer data is admitted only
  after the go-live gate in §7 passes.

## 2. Preconditions that block any real-data release

The security register says release is **blocked** (one Critical, four Highs). Under CLAUDE.md
§14 those block release, whatever the hosting. Phase 1 may run while they are open because it
holds no customer data. Phase 2 may not.

| Item | What it is | Why it matters for hosting |
|---|---|---|
| SR-001 (Critical, due 2026-10-09) | Upstash token committed to a public repository | Rotate it today, before any Azure secret is created alongside it |
| SR-003 (High) | RLS not enforced at runtime; apps connect as the owner role | A hosted multi-tenant deployment without RLS is one bug away from a cross-institution breach |
| SR-004 (High) | Development stand-ins wired into the production entry points | A hosted build would mark bureau reports and payments delivered without delivering them |
| SR-005 (High) | Consumer sign-in accepts any applicant reference | Anyone on the internet could view another applicant's offers |
| SR-018 (High) | Review API reads not covered by a contract test | Fix landed; the test is owed |
| SR-021 (Medium) | No branch protection | The `prod` branch below depends on it |
| SR-040 (Medium) | The repository is public | Licence enforcement in public source can be removed by anyone who builds it. Decide before licensing ships |

## 3. Branches and promotion

- **`main`** — integration. Every push runs `security.yml` and `gateway.yml`.
- **`prod`** — what is deployed to `sanad.iotatechnologies.io`. Cut from the first commit on
  `main` whose gates are all green (`f5c2d13` or later). It moves forward only by a pull
  request from `main`, never by a direct push.
- **Protection on `prod`** (closes SR-021 for this branch; `main` should get the same):
  required checks `security` and `gateway`, one approving review from someone other than the
  author, signed commits, no force push, enforced for administrators.
- **Release tags** `vYYYY.MM.DD-N` on `prod`. The deployment workflow deploys a tag, so what
  runs is always a named, reproducible commit.
- **Release gate as code.** The deployment job refuses to run while
  `docs/SECURITY-REGISTER.md` lists an open Critical or High against a real-data environment.
  A synthetic environment may deploy with them open and says so on its banner.

## 4. What runs where

One deployment is one jurisdiction (ADR 0005). Hosting both the Kingdom and the UAE means two
deployments in two regions, never one deployment serving both.

| Component | Azure service | Hostname (KSA deployment) | Exposure |
|---|---|---|---|
| Consumer app (`apps/consumer`) | Container App | `sanad.iotatechnologies.io` | Public |
| Ops workbench (`apps/ops`) | Container App | `ops.sanad.iotatechnologies.io` | Public, staff sign-in |
| Admin (`apps/admin`) | Container App | `admin.sanad.iotatechnologies.io` | **IP allow-list only**: IOTA and institution networks |
| SME portal (`apps/sme`) | Container App | `sme.sanad.iotatechnologies.io` | Not deployed until SR-019 puts it behind sign-in |
| Origination API (`services/origination`) | Container App | `api.sanad.iotatechnologies.io` | Public, partner credentials; through API Connect where an institution requires it |
| Outbox worker (`services/outbox`) | Container App (no ingress) | — | Internal |
| Temporal (ADR 0003) | Container App (self-hosted) on the same PostgreSQL | — | Internal. Temporal Cloud has no in-Kingdom region, so it is not an option for Phase 2 |
| Cache | Azure Cache for Redis | — | Private endpoint. Replaces Upstash (SR-001) |
| Images | Azure Container Registry | — | Private |
| Secrets | Key Vault, read by managed identity | — | Private endpoint |
| Edge | **Application Gateway WAF v2, in-region** | — | Public |
| Logs and metrics | Log Analytics + Azure Monitor, in-region | — | Private |

The UAE deployment, when it comes, mirrors this table in UAE North under
`ae.sanad.iotatechnologies.io`.

**Why Application Gateway and not Front Door.** Front Door ends TLS at Microsoft's global
edge, so customer data would be decrypted outside the Kingdom. Application Gateway ends TLS in
the deployment's own region.

**Separate subdomains on purpose.** Each app gets its own origin, so a consumer-app session
cookie can never be sent to admin or ops, and the CSP and `frame-ancestors` rules from SR-027
apply per app.

## 5. Phase 1 — hosted, synthetic (target: about 1 week once approved)

1. **Rotate SR-001.** Precondition for everything else.
2. **Azure foundations**, as Bicep in `deploy/azure/` (no click-ops). Covers the resource
   group, ACR, Container Apps environment, Key Vault, Log Analytics, Application Gateway and
   managed identities. The region for Phase 1 can be any region, because the data is
   synthetic. Use the region Phase 2 will use where it offers every service, so Phase 2 is a
   data move, not a rebuild.
3. **Images.** A `Containerfile` per app beside the existing
   `services/origination/Containerfile`. Next.js `output: 'standalone'`, non-root user,
   distroless or slim base, pinned by digest. Trivy image scan in CI (part of SR-032).
4. **Pipeline** `.github/workflows/deploy-azure.yml`: on a release tag on `prod`, build, scan,
   push to ACR and deploy. GitHub authenticates to Azure by **OIDC federated credential**, so
   no Azure secret is stored in GitHub.
5. **Secrets.** Session masters, the database URL and the staff and partner development
   tokens go into Key Vault and reach containers as Key Vault references. Integration
   credentials stay in the Supabase vault for Phase 1 (`config.get_integration_credential`).
   Closes the environment half of SR-034.
6. **DNS.** In the zone that holds `iotatechnologies.io`: CNAMEs for each hostname to the
   Application Gateway, and Key Vault-managed TLS certificates.
7. **Residency banner.** The deployment profile records `synthetic`. Every app shows a banner
   saying no real data may be entered, and the existing residency test asserts the profile.
8. **Smoke test.** Sign in to ops as each development role, run a business application through
   to offer, and quote a consumer product with full disclosure.

## 6. Phase 2 — hosted, real data

1. **Region.** Confirm that an in-Kingdom Azure region is available to our subscription, and
   that Container Apps, PostgreSQL Flexible Server, Key Vault managed HSM, Redis and
   Application Gateway are offered there. Check with
   `az account list-locations` and `az provider show`, then confirm with Microsoft. If
   Container Apps is not offered there, fall back to AKS. ADR 0003's OpenShift manifest is the
   starting point.
2. **Regulatory.** IOTA becomes an outsourcing provider to each institution that uses the
   hosted service. That institution notifies SAMA under the outsourcing rules, and IOTA must
   meet NCA CCC (cloud) as a provider. This is a legal and compliance workstream, not an
   engineering one, and it is the longest lead-time item in this plan.
3. **Database.** Azure Database for PostgreSQL Flexible Server, private endpoint,
   customer-managed key in managed HSM, zone-redundant HA, point-in-time restore. Apply
   `supabase/migrations` as an owner role; the apps run as `sanad_app` (`NOBYPASSRLS`), which
   closes SR-003.
4. **Vault.** Azure PostgreSQL has no Supabase Vault. Re-implement
   `config.set_integration_credential` and `config.get_integration_credential` against Key
   Vault behind the same interface, with every read still audited. This is the largest
   engineering item in Phase 2.
5. **Data.** Nothing moves from Supabase. Phase 2 starts empty, and synthetic data never
   enters a real-data environment.
6. **Disaster recovery.** Agree RPO and RTO per institution. Geo-redundant backups stay in the
   Kingdom, so the paired region must also be in-Kingdom or backups are zone-redundant only.

## 7. Go-live gate for real data

Every one of these is true and evidenced in the release record:

- [ ] No open Critical or High in the security register.
- [ ] Phase 2 region confirmed in-Kingdom; residency test passes against the live profile.
- [ ] RLS enforced at runtime and proven by a contract test in CI (SR-003, SR-024).
- [ ] No development stand-in reachable under the production profile (SR-004, SR-005).
- [ ] Production staff sign-in through the institution's SSO (ops module is `BLOCKED` today).
- [ ] Penetration test of the hosted environment, findings registered.
- [ ] The institution's SAMA outsourcing notification made; IOTA's NCA cloud obligations met.
- [ ] A valid production licence installed (ADR 0006).

## 8. What we need from the product owner

1. Approval of this plan and of ADR 0006.
2. **Sign in with `az login`** and say which subscription and tenant to use. Then we run the
   region and service availability checks in §6.1 before writing any Bicep.
3. **DNS:** who manages the `iotatechnologies.io` zone (Azure DNS, Cloudflare, or a
   registrar), and who can add records.
4. **SR-001:** rotate the Upstash token today.
5. **SR-040:** decide whether the repository stays public.
