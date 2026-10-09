# Security Register

**Status:** Live register (SEC-M01)
**Opened:** 2026-10-08
**Owner of the register:** the CISO function. Until the client CISO is named, the product owner holds it.
**Companions:** `docs/CYBERSECURITY-REQUIREMENTS.md` (the requirements), `docs/THREAT-MODEL.md`
(where each item was found and why it matters)

This is the single register SEC-M01 requires. Every finding goes here, whatever its source:
SAST, SCA, DAST, pen test, internal review, vendor advisory. Each item has one SLA clock and
one owner. No secret value, token or personal datum is ever written here. An item names
where a secret was exposed, never what it was.

**SLA clock (CLAUDE.md §14, SEC-V10).**

| Severity | Due | Release impact |
|---|---|---|
| Critical | 24 hours | Blocks release, and production operation if live |
| High | 7 days | Blocks release |
| Medium | 30 days | Does not block. Needs an owner and an accepted-risk record (SEC-C01 #2) |
| Low | 90 days | Backlog |

Severity is raised one step where a finding touches a Shariah control, the audit chain,
signing or tenant isolation (SEC-V10).

---

## Summary at 2026-10-08

| | Open | In remediation | Closed | Total |
|---|---|---|---|---|
| Critical | 1 | 0 | 0 | 1 |
| High | 3 | 1 | 0 | 4 |
| Medium | 21 | 1 | 0 | 22 |
| Low | 8 | 0 | 0 | 8 |
| Closed (High 2, Medium 3, Low 1) | | | 6 | 6 |
| **Total** | **33** | **2** | **6** | **41** |

**Release status: blocked.** One Critical and four Highs are open or in remediation, so
SEC-C01 condition 1 is not met.

---

## Register

Raised 2026-10-08 unless stated otherwise. Due dates follow the SLA clock above:
Critical 2026-10-09, High 2026-10-15, Medium 2026-11-07, Low 2027-01-06.

The register is split into one table per severity so it stays readable. Every table has the
same columns: ID, title, threat ref, status, raised, due, owner, the control or fix
required, and the test that proves the item closed.

### Critical

| ID | Title | Threat ref | Status | Raised | Due | Owner | Control or fix required | Test that proves it closed |
|---|---|---|---|---|---|---|---|---|
| SR-001 | Upstash Redis REST URL and token committed in `.env.example` in commit `485e57d`. The repository is **public**, so the token is exposed to the internet. Raised from High to Critical because the repository is public | SEC-TM10, SEC-D05 | Open | 2026-10-08 | 2026-10-09 | Product owner (rotation); Platform engineering (detection) | Revoke and rotate the token at the provider now. Confirm in the provider's access log that nobody else used it. Record the rotation, without the value, in this row. Rewriting history does not un-leak a secret; rotation is the fix | A custom gitleaks rule for the Upstash token shape, run over all refs (see SR-023), reports the historical commit as an allow-listed **rotated** finding. Evidence: the provider's revocation record |

### High

| ID | Title | Threat ref | Status | Raised | Due | Owner | Control or fix required | Test that proves it closed |
|---|---|---|---|---|---|---|---|---|
| SR-003 | RLS is not enforced at runtime. No code sets `sanad.tenant_id`. Apps and services connect with the session-pooler `postgres` (owner) login. `FORCE ROW LEVEL SECURITY` is applied only to the `0003` and `0004` tables. The runtime tables (`0006`, `0008`, `0009`, `0011`, `0012`, `0014`, `0016`) are `ENABLE` only. The owner can also read `vault.decrypted_secrets` and disable triggers | SEC-TM08, SEC-TM02, SEC-TM07, SEC-TM10 | Open | 2026-10-08 | 2026-10-15 | Platform engineering | Run as a `NOBYPASSRLS` non-owner role (`sanad_app` exists in `0003`). Set `set_config('sanad.tenant_id', …, true)` per transaction from the principal. `FORCE` RLS on every tenant table. Migrations run as a separate owner role | Contract test (run in CI, see SR-024): as `sanad_app` with tenant A set, a select of tenant B rows returns none and an insert for tenant B fails. Architecture test: every tenant table has `relforcerowsecurity`. A test asserts the runtime role is neither owner nor `BYPASSRLS` |
| SR-004 | Development stand-ins are wired into production entry points with no guard. `services/origination/src/index.ts` uses `developmentRegistry` (environment tokens, no expiry or rotation), `developmentSnapshots` and `developmentTimestamps` (host clock). `services/outbox/src/index.ts` uses `developmentDispatchPorts`, which marks bureau-reporting and payment events delivered without delivering them | SEC-TM06, SEC-TM11, SEC-TM14 | Open | 2026-10-08 | 2026-10-15 | Platform engineering | Each stand-in throws when `NODE_ENV=production` or when the deployment profile is not development. Production wiring takes a vault-backed credential registry, live adapters and a TSA adapter, or refuses to start | Architecture test: building the service or worker with any `development*` dependency under a production profile throws, and the entry points pass that check |
| SR-005 | Consumer impersonation: `signInAction` accepts any `applicantRef` matching `^[a-z0-9-]{3,40}$` and authenticates it through `developmentIdentity()`, with no production guard. Anyone can view and accept another applicant's offers | SEC-TM06, SEC-TM12, SEC-TM14 | Open | 2026-10-08 | 2026-10-15 | Platform engineering | Refuse the development identity outside development. In production, sign-in goes through the identity-authentication port (Nafath / UAE Pass) only. The applicant reference comes from the assertion, never from the form | Compliance test: under a production profile `signInAction` refuses; the session's applicant comes from the assertion, not the form field |
| SR-018 | The review API returns other tenants' requests. `GET /api/review/v1/requests/{id}` and `GET /api/review/v1/queue` authenticate staff but never compare the staff principal's tenant with the row's (`apps/ops/src/app/api/review/v1/...`). Writes are protected by `core/origination/request.ts`; reads are not. Raised to High because it breaks tenant isolation | SEC-TM08, SEC-TM12 | In remediation | 2026-10-08 | 2026-10-15 | Platform engineering | Filter every read by `staff.tenantId`. Another tenant's request is reported absent (404), not forbidden. The read filter landed with SR-002 in `a6b6260`; it stays open until the contract test below exists | Contract test: staff of `sme-fund-ae` gets 404 for a `bank-a` request ID and an empty queue for `bank-a` rows |

### Medium

| ID | Title | Threat ref | Status | Raised | Due | Owner | Control or fix required | Test that proves it closed |
|---|---|---|---|---|---|---|---|---|
| SR-006 | `TsaInstant` can be minted outside a TSA. `tsaInstant({ verified: true, … })` is constructed from `Date.now()` in `apps/ops` (`store.ts`, `actions.ts`, `business.ts`), `apps/consumer/src/server/store.ts` and `services/origination/src/server.ts`. No RFC 3161 adapter exists. No test for TSA token reuse | SEC-TM06 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Build the TSA adapter (signature, chain, imprint). Make `VerifiedTimestamp` nominal (a private symbol only the adapter holds). Refuse a token digest already bound to a different message | Architecture test: no module outside the TSA adapter constructs `VerifiedTimestamp`. Adapter test: a token reused for a second imprint is refused |
| SR-007 | Nafath assertion replay is not detected. `adapters/ksa/nafath/adapter.ts` maps `assertionId` without checking freshness or uniqueness. Untested | SEC-TM06 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Record consumed assertion IDs per tenant with a unique constraint. Refuse an assertion older than the step-up window | Adapter or compliance test: the second use of one assertion ID is refused, and an assertion outside the window is refused |
| SR-008 | Hash-chain re-anchoring is untested. The contract-leg chain head is not anchored externally (`products/murabaha-scf/legs/leg.ts`), so a whole chain can be rebuilt consistently | SEC-TM06, SEC-TM07 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Anchor the chain head and each leg to its TSA token (the digest is already on the leg). `verifyChain` re-verifies the tokens | `test/compliance/chain-migration.test.ts` gains a case where a chain is re-built with fresh hashes and is refused because its anchors do not verify |
| SR-009 | The audit chain can be bypassed by direct INSERT. `sanad_app` is granted INSERT and UPDATE on `audit` (`0003`), against CLAUDE.md §7 "No UPDATE grant". No trigger recomputes `prev_hash` or `content_hash` | SEC-TM07 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Revoke INSERT and UPDATE on `audit.*` from every runtime role. Writes go through `audit.record_event()` only, or a BEFORE INSERT trigger computes the hashes itself | DB test (in CI): a direct INSERT as the runtime role is refused; UPDATE is refused by grant, not only by trigger |
| SR-010 | The audit chain forks under concurrency. `audit.record_event()` takes `FOR UPDATE` on the latest row. That does not serialise a tenant's first event, and a writer that waited on the lock reuses the same predecessor. The hash also covers `timestamptz::text`, which depends on the session `TimeZone` | SEC-TM07 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Serialise per tenant (`pg_advisory_xact_lock(hashtext(tenant))` or a per-tenant head row). Hash a canonical UTC epoch, not text | DB test: N concurrent `record_event` calls for one tenant produce one linear chain; verification passes under two different `TimeZone` settings |
| SR-011 | No audit-chain verifier exists (TypeScript or SQL), and there is no periodic integrity check (SEC-O10) | SEC-TM07, SEC-O10 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | `audit.verify_chain(tenant)` and a TypeScript verifier, run on a schedule, with alerting | Test: the verifier passes on a clean chain and names the first broken row after a deleted, altered or reordered row |
| SR-012 | Most state changes are not in the chained audit. Only config revisions, the deployment jurisdiction and merchants call `record_event`. Origination decisions are held in mutable `core.origination_request.request` `jsonb` with no history. Consumer acceptances and SME stage events are append-only but unchained | SEC-TM07, SEC-TM05 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Write a chained audit event in the same transaction as every decision, approval, acceptance, disbursement and configuration change | Contract test per flow: after the act, one chained audit row exists naming the actor, and the chain verifies (SR-011) |
| SR-013 | The duplicate-financing race is untested. `core.financed_invoice_registry` has a unique constraint, but no repository implements `FinancedInvoiceRegistryPort`. Existing tests are sequential and run against an in-memory double | SEC-TM03 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | A PostgreSQL implementation of the port with no upsert. Concurrent drawdowns are tested against it | DB test (in CI): two concurrent `register` calls for one invoice: exactly one succeeds, the other is refused `SH-10` |
| SR-014 | The limit-reservation race is untested. The `core.enforce_facility_capacity()` deferred trigger (`0004`) has no test, and nothing writes `core.limit_reservation` yet | SEC-TM04 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Implement reservation against the table. Test it concurrently | DB test: two concurrent reservations that together exceed the facility: exactly one commits |
| SR-015 | DB-level controls are untested. The Murabaha constraints and triggers in `0003` (risk interval, leg monotonicity, executed-amount immutability, evidence and audit append-only, financed-invoice immutability) have **no** test. Every other DB test is skipped unless `SANAD_TEST_DATABASE_URL` is set | SEC-TM02, SEC-TM05, SEC-TM07 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | A DB compliance suite that attempts each prohibited write directly | `test/contract/db-invariants.test.ts` (new), running in CI against PostgreSQL. Each prohibited write fails with `restrict_violation` or a check violation |
| SR-016 | Rail responses and webhooks cannot be authenticated beyond TLS. No inbound callback or webhook verification exists. ZATCA `stampValid` is read from a response field (`adapters/ksa/zatca-einvoicing/adapter.ts`) instead of verifying the cryptographic stamp. The `Sanad-Signature` outbound signer is declared but not implemented. No mTLS or pinning to rails | SEC-TM11 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Verify the ZATCA stamp and QR cryptographically. Implement an HMAC or detached signature on outbound webhooks. Any inbound callback verifies a signature and timestamp before parsing, and is idempotent. mTLS where the rail offers it | Adapter test: a clearance with a forged stamp is refused. A webhook test: an unsigned or altered body is refused, and a replayed timestamp is refused |
| SR-019 | BOLA negative tests are missing for the checkout session (another merchant), the consumer offer (another applicant) and the business application (another tenant). The controls exist in code. The SME portal (`apps/sme`) has no authentication (fixture data) | SEC-TM12 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Write the negative tests. Put the SME portal behind sign-in before it reads real data | Contract tests: each identifier from another principal answers 404 |
| SR-021 | No branch protection on `main` (`gh api …/branches/main/protection` returns 404) and unsigned commits (`%G?` = N on recent history). Shariah structure files change through git alone | SEC-D15, SEC-TM09 | Open | 2026-10-08 | 2026-11-07 | Product owner (repository admin) | Protect `main`: no direct push, required review, required status checks (`security`, `gateway`), signed commits, enforced for admins | Evidence: the branch protection API response saved with the release record. A scheduled check fails if protection is removed |
| SR-023 | The gitleaks job does not scan full history. On `push`, `gitleaks-action` scans the pushed commit range, and it passed (run 37830450919) with SR-001 in history | SEC-D05 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Run `gitleaks detect --log-opts="--all"` (the CLI) over all refs. Add a custom rule for Upstash and Supabase key shapes | The CI job fails on a seeded test repository carrying a known token in an old commit |
| SR-024 | CI runs only the compliance and architecture suites (`security.yml`), plus two gateway tests. Unit, contract and adapter suites do not run in CI. No PostgreSQL service, so no DB test ever runs in CI | SEC-D01, SEC-D13 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Add a job that runs the full suite with a PostgreSQL service, applies the migrations and sets `SANAD_TEST_DATABASE_URL` | That job is green, and the DB-skipped tests report as run, not skipped |
| SR-025 | Shariah parameters sit outside four eyes. Structures and board positions (`config/tenants/*/structures`) are not a `config.revision` area. The floor is `MINIMUM_RISK_PERIOD_SECONDS = 1`. No excluded-goods register exists. `templateVersionId` is checked only for being non-empty | SEC-TM09 | Open | 2026-10-08 | 2026-11-07 | Platform engineering; Shariah governance (rulings) | Add STRUCTURES and BOARD_POSITIONS revision areas under maker-checker. Add an excluded-goods register and a template registry bound to the board approval. A per-tenant floor recorded from the board ruling | Compliance tests: a structure change is not effective until a second person approves; a lower interval than the board's ruling is refused; goods on the register are refused; an unapproved template version is refused |
| SR-026 | Rail adapters check consent presence only. `requireConsent` (`adapters/ksa/kernel/rail-adapter.ts`) accepts any non-empty string. Liveness, purpose and tenant are checked upstream (`core/consent/consent.ts`), not at the rail | SEC-R07 (PDPL), CLAUDE.md §5 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Pass a verified consent (a branded type produced only by `requireConsent` in core) to the port, not a string | Adapter test: a call with a consent ID that is expired, for another purpose or for another tenant is refused before any transport call |
| SR-027 | No browser security headers on any Next app (`apps/*/next.config.mjs`): no CSP, `frame-ancestors`, HSTS, `X-Content-Type-Options` or `Referrer-Policy`. Ops approvals and admin decisions can be framed | SEC-R09, SEC-R10 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | A strict CSP with nonces, `frame-ancestors 'none'`, HSTS, `nosniff` and `Referrer-Policy` on all four apps | UI or architecture test: each app's response carries the headers |
| SR-031 | No application-level rate limiting or anti-automation per principal or tenant. The gateway products deliberately carry no hard limit | SEC-O02 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Per-principal and per-tenant limits in the service (Redis), plus gateway plans per client | Contract test: the N+1th request in the window answers 429 with `Retry-After` |
| SR-032 | Several SEC-D gates are not yet built: image scan (D09, filesystem only today), DAST (D11), licence gate beyond dependency review (D12), suppression expiry (D14) | SEC-D09, SEC-D11, SEC-D12, SEC-D14 | Open | 2026-10-08 | 2026-11-07 | Platform engineering | Trivy image scan of the `services/origination/Containerfile` build; ZAP baseline against UAT; a licence policy; a suppression file with owner and expiry, enforced | Each job present in `security.yml` and failing on a seeded violation |
| SR-039 | No threat model (requirements §9 gap #6). `docs/THREAT-MODEL.md` drafted 2026-10-08, not yet reviewed or committed | SEC-TM01 | In remediation | 2026-10-08 | 2026-11-07 | CISO (review); Platform engineering (author) | Review, commit, and re-run per release | Evidence: the reviewed, dated model in the release pack (SEC-C01 #5) |
| SR-040 | The repository is public. Source, schema, invariants, the Supabase project reference (ADR 0004) and the API Connect org and host (`ibm.yml`) are published | SEC-R01, SEC-TM10 | Open | 2026-10-08 | 2026-11-07 | Product owner | Decide whether public visibility is intended. If not, make it private and treat everything published as known | Evidence: the visibility decision recorded as an ADR |

### Low

| ID | Title | Threat ref | Status | Raised | Due | Owner | Control or fix required | Test that proves it closed |
|---|---|---|---|---|---|---|---|---|
| SR-017 | `APPLICATION_ID_TAKEN` as an existence oracle. **Verified within-tenant only**: the book is per tenant and the primary key is `(tenant_id, application_id)`, so it is not cross-tenant. It still reveals, to the tenant's own upstream credential, that an ID exists under another reference | SEC-TM12 | Open | 2026-10-08 | 2027-01-06 | Platform engineering | Accept the risk (the caller already holds `business:read` for the tenant), or answer a generic conflict | Contract test: the same `applicationId` handed over in two tenants succeeds in both |
| SR-020 | The ops document route `GET /api/documents/v1/artefacts/{id}` serves bytes without authentication or a production guard (synthetic samples only today), and does not re-verify the artefact hash | SEC-TM12, SEC-TM05 | Open | 2026-10-08 | 2027-01-06 | Platform engineering | Require a staff session and a tenant match. Verify the hash on read | Contract test: no session gives 401; another tenant's document gives 404 |
| SR-022 | `.github/workflows/ibm.yml` lacks the required `api_folders` input. `API_FILES` names `health_1.0.0.yaml`, which does not exist (the file is `gateway/ibm/health-api_1.0.0.yaml`). No `permissions:` block | SEC-D01 | Open | 2026-10-08 | 2027-01-06 | Platform engineering | Supply the inputs the action requires, point at real files, and set `permissions: contents: read` | The workflow run is green and discovers the intended API |
| SR-029 | Security-definer functions put `public` on the `search_path` (`record_event`, `set_`/`get_integration_credential`, the revision functions). `config.revision_payload(p_id)` takes no tenant and returns any tenant's payload | SEC-TM08, SEC-TM10 | Open | 2026-10-08 | 2027-01-06 | Platform engineering | `set search_path = ''` with qualified names. Scope `revision_payload` by tenant | Architecture test over migrations: no `security definer` function has `public` on its `search_path` |
| SR-030 | Sealed sessions cannot be revoked. Admin and consumer cookies are stateless; sign-out deletes the cookie, but a copied token stays valid until expiry (admin at most one hour) | SEC-R09 (ASVS V3) | Open | 2026-10-08 | 2027-01-06 | Platform engineering | A server-side session ID or a revocation list checked on open | Unit test: a token issued before sign-out is refused after it |
| SR-033 | The Semgrep rule `sanad-no-tenant-id-from-client` matches only `req.body.tenantId` and `req.query.tenantId`, at WARNING. It misses `FormData` fields (`field(form, 'tenant')`) | SEC-D03, SEC-TM08 | Open | 2026-10-08 | 2027-01-06 | Platform engineering | Extend the rule to `FormData.get` and `searchParams.get` of `tenant*`. Raise it to ERROR | Semgrep rule test with positive and negative fixtures |
| SR-034 | Session master secrets (`ADMIN_SESSION_SECRET`, `CONSUMER_SESSION_SECRET`) and the partner, staff and admin development tokens come from environment variables, not the vault. The consumer session comment says "comes from the vault", but the code reads the environment. `STAFF_DEV_TOKEN_SENIOR` signs in as both the ops senior checker and admin `adm-dev-02` | SEC-TM10, SEC-O07 | Open | 2026-10-08 | 2027-01-06 | Platform engineering | Master secrets from the vault with rotation. One development token per person per app | Unit test: a production profile with no vault reference refuses to start. Architecture test: no token variable is read by two apps |
| SR-041 | The hosted Supabase project's PostgREST exposed-schema setting is not asserted. Only the local `supabase/config.toml` is checked | SEC-TM02, SEC-TM08 | Open | 2026-10-08 | 2027-01-06 | Platform engineering | Read the setting from the hosted project's management API in a scheduled check | Scheduled check: the exposed schemas are exactly `public` and `graphql_public` |

### Closed

| ID | Title | Threat ref | Severity | Status | Raised | Closed | Owner | Control or fix | Closed by |
|---|---|---|---|---|---|---|---|---|---|
| SR-002 | Ops workbench had no sign-in. Screens and server actions acted as hard-coded principals (`session.ts` `MAKER`/`CHECKER`; `business.ts` `BUSINESS_ROLES`), the tenant came from a form field, and one person held maker, checker, committee and finance at once | SEC-TM14, SEC-TM08, SEC-TM12, SEC-TM13 | High | Closed | 2026-10-08 | 2026-10-08 | Platform engineering | Staff sign-in with a sealed session (`apps/ops/src/server/staff-session.ts`, `middleware.ts`). Principal and tenant come from the session only; each action checks the person's authority; production refuses development identities. Production SSO is not built (module BLOCKED) | Commit `a6b6260`. Tests `test/compliance/ops-staff-session.test.ts` and `test/unit/ops-business-actions.test.ts` (no session refused, forged/expired cookie refused, tenant form field ignored, one person cannot key and verify, present and validate, or submit and decide; missing authority refused) |
| SR-028 | The Semgrep container was unpinned in `security.yml` (`semgrep/semgrep`) | SEC-D17 | Low | Closed | 2026-10-08 | 2026-10-08 | Platform engineering | Pinned to `semgrep/semgrep:1.180.0` by digest | The commit after `a6b6260` that adds this register. An architecture test asserting every `container:` and `uses:` is pinned remains to be written |
| SR-035 | 36 compiled `.js` files tracked beside the `.ts` sources (requirements §9 #4) | SEC-D16 | Medium | Closed | 2026-10-08 | 2026-10-08 | Platform engineering | Untracked, and compiled output ignored per source tree in `.gitignore` | Commit `6ac4b01`. No test asserts it yet; adding one to `test/architecture/secrets.test.ts` (no tracked `.js` beside a `.ts`) is recommended |
| SR-036 | GitHub Actions pinned to tags or `@master` (requirements §9 #7) | SEC-D17 | Medium | Closed | 2026-10-08 | 2026-10-08 | Platform engineering | Every `uses:` in `security.yml`, `gateway.yml` and `ibm.yml` is pinned to a full SHA | Commit `6ac4b01`. The container pin is tracked separately as SR-028 |
| SR-037 | No security scanning in CI (requirements §9 #1, #3, #5) | SEC-D01..D08, SEC-D13 | High | Closed | 2026-10-08 | 2026-10-08 | Platform engineering | `security.yml`: CodeQL, Semgrep with Sanad rules, gitleaks, OSV and npm audit, dependency review, SBOM, Trivy filesystem, compliance suite | Commits `6ac4b01`, `0b9dfe9`, `77e07dc`. Run 37830450919 green. Coverage limits are tracked as SR-023, SR-024 and SR-032 |
| SR-038 | AES-GCM authentication tag length not fixed on the sealed-token cipher (Semgrep `gcm-no-tag-length`). Also §9 #2: no security section in CLAUDE.md, closed by CLAUDE.md §14 in `6ac4b01` | SEC-TM06, SEC-R09 | Medium | Closed | 2026-10-08 | 2026-10-08 | Platform engineering | `authTagLength: 16` on cipher and decipher (`packages/auth/sealed-token.ts`) | Commit `0b9dfe9`. Test `test/unit/consumer-session.test.ts` "refuses a truncated authentication tag, which GCM would otherwise accept" |

---

## How to use this register

**Raising an item.**
- Anyone who finds a weakness adds a row with the next `SR-` number.
- Fill in the threat reference (`SEC-TMxx`, `SEC-Dxx`, `SEC-Rxx` or `SEC-Oxx`), a severity from the clock above (raised one step for Shariah, audit, signing or tenant isolation), the date raised, the due date from the clock, and an owner by role.
- If no named person holds that role, the owner is the product owner.
- Write what was found and where, never the secret or the personal datum itself.
- A Critical is also reported to the product owner and the client CISO the same day, and gets a root-cause analysis (SEC-V12).

**Closing an item.**
- An item closes only when a test exists that fails on the weakness and passes on the fix, and that test runs in CI.
- The row records the commit and the test name.
- "Fixed in code" with no test is *In remediation*, not *Closed*.
- An item with no possible test (a rotation, a repository setting, a policy decision) closes on recorded evidence: the provider's revocation record, the saved API response, or the ADR.
- Every Critical and High raised by a pen test is closed only after retest by the original provider (SEC-V11). Self-attested closure is not accepted.
- If a class of finding recurs, the fix is a CI control, not another patch (SEC-V12).

**Accepting a risk.**
- A Medium or Low may be accepted instead of fixed, by the product owner with the CISO, in writing, with an expiry.
- The row stays Open with status *Accepted until <date>*. An expired acceptance is Open again.
- Critical and High cannot be accepted for a release (SEC-C01 #1).

**Review.**
- Platform engineering reviews the register weekly.
- It is reported monthly to the client CISO as open items by severity and age, SLA adherence, and gate pass rates (SEC-M04).
- At each release it is re-read against the threat model (SEC-TM01), and the release is blocked while any Critical or High is not Closed.

---

## Open questions for the client CISO (SEC-Q01..Q08)

None has been answered in this repository as of 2026-10-08.

| Ref | Question | Status | Working assumption until answered |
|---|---|---|---|
| SEC-Q01 | Is Sanad classified a critical system (NCA CSCC)? | Open | Design to ECC-2:2024. Treat CSCC as likely |
| SEC-Q02 | Target SAMA CSF maturity level? | Open | Level 3 |
| SEC-Q03 | Does any module touch cardholder data (PCI DSS)? | Open | No. No PAN, card number or CVV field exists in `core/`, `products/`, `api/`, `apps/`, `services/` or `adapters/` (checked 2026-10-08). Card rails stay behind the payments hub |
| SEC-Q04 | Which NCA-licensed provider performs VAPT, and can the client's panel be used? | Open | None engaged. The provider's licence is to be verified before engagement (SEC-R13) |
| SEC-Q05 | Does the client SOC monitor the platform, or is monitoring IOTA's responsibility? | Open | IOTA, until told otherwise. No SIEM integration exists (SEC-O03) |
| SEC-Q06 | Regulatory notification timelines and contacts for SAMA, NCA and SDAIA? | Open | None recorded. The IR runbook (SEC-I02) cannot be completed |
| SEC-Q07 | Is a bug bounty or responsible disclosure programme in scope? | Open | No channel exists (SEC-V09). The repository is public (SR-040), so a disclosure contact is advisable now |
| SEC-Q08 | Who signs the clean chit, and do they accept the §5 definition? | Open | To be agreed in writing before any testing begins |
