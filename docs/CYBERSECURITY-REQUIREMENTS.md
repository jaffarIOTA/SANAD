# Cybersecurity Requirements & Assurance Programme

Sanad — KSA Loan Origination Platform.
Requirements are identified `SEC-*` and are traceable to design, build, test and evidence.

> **Why this document exists.** SDD v0.2 §4.7 described a security *architecture*. It did not
> state verifiable security *requirements*, name the Saudi regulatory baseline beyond SAMA, or
> define an assurance programme. Without those there is nothing for a CISO to sign, and
> "clean chit" has no definition. This closes that gap.

---

## 1. Regulatory baseline

A Saudi financial institution is subject to **two** cybersecurity regulators, not one. SDD v0.2
named only SAMA. Both apply.

| Ref | Framework | Applies because | Obligation |
|---|---|---|---|
| SEC-R01 | **NCA ECC-2:2024** — Essential Cybersecurity Controls | Mandatory for national entities and their service providers | Control-by-control compliance mapping, evidenced, with annual self-assessment |
| SEC-R02 | **NCA CSCC** — Critical Systems Cybersecurity Controls | Applies if the deploying institution classifies Sanad a critical system. **Determine early — it materially raises the bar.** | Enhanced controls over the ECC baseline |
| SEC-R03 | **NCA CCC** — Cloud Cybersecurity Controls | Any cloud hosting | Classification-driven; constrains region, tenancy model, and the exit plan |
| SEC-R04 | **NCA DCC** — Data Cybersecurity Controls | Personal and financial data at scale | Classification, lifecycle, destruction |
| SEC-R05 | **SAMA Cyber Security Framework** | Deploying institution is SAMA-regulated | Target maturity to be confirmed with the client CISO; **assume Level 3 (structured and formalised) as the design point** |
| SEC-R06 | **SAMA Cloud Computing Regulatory Rules** | Cloud hosting of regulated data | In-Kingdom residency, approvals, exit plan |
| SEC-R07 | **PDPL (SDAIA)** | Personal data | Lawful basis, rights, breach notification, no cross-border transfer |
| SEC-R08 | **PCI DSS** | **Conditional.** Applies only if any module handles cardholder data. The BNPL and embedded-lending modules make this a live question. | **Open item — determine scope before building any card-adjacent flow.** Cheapest answer is to design PANs out entirely. |
| SEC-R09 | **OWASP ASVS 5.0 Level 2** platform-wide; **Level 3** for authentication, cryptography, signing, the sequencing engine and the audit chain | Verification standard | Every ASVS control mapped to a test or an accepted risk |
| SEC-R10 | **OWASP Top 10** and **API Security Top 10** | Application attack surface | Covered by SAST rules and pen test scope |
| SEC-R11 | **OWASP MASVS** | If a native mobile app ships | Mobile-specific verification |
| SEC-R12 | **CIS Benchmarks** — Linux, Docker, Kubernetes, PostgreSQL | Infrastructure hardening | Automated benchmark scanning, drift alerting |

**SEC-R13 — Supplier assurance.** Penetration testing and security assessment must be performed
by a provider **licensed by the NCA to deliver cybersecurity services in the Kingdom**. An
unlicensed firm's report will not satisfy the client's regulator. Verify the licence before
engaging, not after the report lands.

---

## 2. Threat model

**SEC-TM01** A STRIDE threat model is maintained per trust boundary, reviewed each release and
re-run whenever a boundary changes. Boundaries: internet edge, API Connect gateway, service mesh,
database, Vault, signing service, each external rail, and each tenant boundary.

### 2.1 Product-specific abuse cases

Generic web testing will not find these. They are the ones that matter, and they must appear
verbatim in every pen test scope.

| Ref | Abuse case | Why it is severe |
|---|---|---|
| SEC-TM02 | **Sequencing gate bypass** — reach a sale leg without ownership, possession or risk period, via direct DB write, PostgREST, a race, or a crafted state transition | Produces a non-compliant contract. Regulatory and Shariah incident, not a bug. |
| SEC-TM03 | **Duplicate financing race** — two concurrent drawdowns against one invoice identifier | Financing goods twice means selling what was not owned |
| SEC-TM04 | **Limit reservation race** — concurrent drawdowns both consuming the last capacity | Uncontrolled credit exposure |
| SEC-TM05 | **Document tampering after execution** | Destroys evidentiary value of every contract |
| SEC-TM06 | **Signature or timestamp forgery / replay** — reuse a TSA token, replay a Nafath assertion, re-anchor a hash chain | Breaks non-repudiation; contracts become unenforceable |
| SEC-TM07 | **Audit chain tampering** — insert, delete or reorder audit events | Removes the institution's ability to prove anything |
| SEC-TM08 | **Cross-tenant data access** — one institution reads another's transactions, policies or divergence configuration | Catastrophic for the multi-client product strategy |
| SEC-TM09 | **Shariah parameter tampering** — set a minimum risk period to zero, empty an excluded-goods register, swap a template version | Silently converts compliant products into non-compliant ones |
| SEC-TM10 | **Credential exfiltration** from Vault, memory, logs or error paths | Full compromise of core banking and document platform |
| SEC-TM11 | **Rail response spoofing** — forged ZATCA clearance, forged registry response, forged webhook | Fraudulent financing against fabricated trades |
| SEC-TM12 | **BOLA / IDOR** on transaction, counterparty, document and evidence identifiers | Mass data exposure; the most common real-world API breach |
| SEC-TM13 | **Mass assignment** on application payloads — set `profit_amount`, `state` or `tenant_id` from the client | Direct financial manipulation |
| SEC-TM14 | **Privilege escalation to an override** — obtain an entitlement that advances a gate | The platform's central claim is that no such entitlement exists. This must be tested adversarially, not asserted. |

---

## 3. Secure development — the CI gates

**SEC-D01** Every control below runs in CI on every pull request. A failing gate **blocks merge**.
A gate that only warns is not a gate.

| Ref | Control | Tool | Blocks on |
|---|---|---|---|
| SEC-D02 | **SAST** | CodeQL (`security-extended`) | Any Critical or High |
| SEC-D03 | **SAST — custom rules** | Semgrep with Sanad-specific rules | Any finding. Rules encode the invariants: no rate persisted outside `products/murabaha-scf` exemptions, no domain table in `public`, no raw SQL interpolation, no secret in code, no `new Date()` in sequencing. |
| SEC-D04 | **Secrets — staged** | existing `scripts/scan-staged.mjs` | Any match |
| SEC-D05 | **Secrets — full history** | Gitleaks over all refs | Any match. A secret committed and later removed is still leaked. |
| SEC-D06 | **SCA / dependencies** | OSV-Scanner + `npm audit` | Critical or High with a fix available |
| SEC-D07 | **Dependency review** | GitHub dependency-review on PR diff | New Critical or High, or a disallowed licence |
| SEC-D08 | **SBOM** | CycloneDX, generated per release, retained | Generation failure |
| SEC-D09 | **Container scan** | Trivy, image and filesystem | Critical or High |
| SEC-D10 | **IaC scan** | Trivy / Checkov | Critical or High misconfiguration |
| SEC-D11 | **DAST** | OWASP ZAP baseline against the deployed UAT build | New High |
| SEC-D12 | **Licence compliance** | Deny copyleft in distributed code | Any violation |
| SEC-D13 | **Compliance suite** | existing `npm run test:compliance` | Any failure. This is a security gate, not only a Shariah one — every test in it is an authorisation-bypass test. |

**SEC-D14 — No suppression without an owner.** A suppressed finding requires a dated justification,
a named owner and an expiry. Expired suppressions fail the build.

**SEC-D15 — Branch protection.** No direct push to `main`. Signed commits. Required reviews.
Required status checks. Enforced for administrators.

**SEC-D16 — Build artefacts are not committed.** Compiled `.js` alongside `.ts` sources
(36 files currently tracked) means reviewed source and executed artefact can diverge. Build in CI,
publish from CI, and remove committed output.

**SEC-D17 — Pinned, provenance-verified dependencies.** Lockfile committed, CI uses `npm ci`,
GitHub Actions pinned to commit SHAs not tags.

---

## 4. VAPT programme

### 4.1 Scope

**SEC-V01** Each engagement covers all of:

| Layer | Content |
|---|---|
| **Web application** | All five surfaces: SME, anchor, operations, Shariah audit, admin |
| **API** | Every exposed endpoint, authenticated and unauthenticated, including the API Connect gateway configuration itself |
| **Business logic** | **The abuse cases in §2.1, individually, by name.** The tester's objective is to produce a non-compliant transaction. This is the single most important part of the engagement and is routinely omitted from standard scopes. |
| **Authorisation** | Horizontal and vertical, cross-tenant, and an explicit attempt to obtain a gate-bypass entitlement |
| **Infrastructure** | External and internal network, hosts, containers, orchestration |
| **Cloud configuration** | Review against NCA CCC and CIS benchmarks |
| **Database** | RLS efficacy, schema exposure, PostgREST reachability, privilege model |
| **Cryptography** | Key custody, signing flow, TSA handling, hash chain integrity, transport configuration |
| **Mobile** | If a native app ships |
| **Social engineering** | By client agreement only |

**SEC-V02** Testing is performed **grey-box and authenticated** at minimum, with credentials for
every role. A purely black-box test will miss every finding that matters here.

**SEC-V03** The pen test provider receives this document, the threat model and the SDD. Scope is
agreed in writing, including the §2.1 abuse cases as named test objectives.

### 4.2 Cadence

| Ref | When | Type |
|---|---|---|
| SEC-V04 | Before every production go-live | Full VAPT. **Mandatory gate.** |
| SEC-V05 | Annually thereafter | Full VAPT |
| SEC-V06 | After any material architectural change | Targeted VAPT |
| SEC-V07 | Each release | Automated DAST plus the full CI gate set |
| SEC-V08 | Annually, once mature | Red team / adversary simulation, objective-based |
| SEC-V09 | Continuous | Responsible disclosure channel with defined response times |

### 4.3 Severity and remediation

**SEC-V10** CVSS v4.0, with severity adjusted upward where a finding touches a Shariah control,
the audit chain, signing, or tenant isolation — because consequence there is regulatory, not
merely technical.

| Severity | Remediate within | Release impact |
|---|---|---|
| Critical | 24 hours | Blocks release. Blocks production operation if live. |
| High | 7 days | Blocks release |
| Medium | 30 days | Does not block; tracked with an owner |
| Low | 90 days | Backlog |
| Informational | Best effort | Backlog |

**SEC-V11** Every Critical and High requires **retest by the original provider** and written
confirmation of closure. Self-attested closure is not accepted.

**SEC-V12** Root cause analysis for every Critical. If a class of finding recurs, the fix is a
control in CI (§3), not another patch.

---

## 5. What "clean chit" means

**SEC-C01** Security sign-off is granted only when **all** of the following hold. This is the
definition — nothing less is sign-off, and it should be agreed with the client CISO in writing
before testing begins, so the bar is not negotiated after findings land.

| # | Condition | Evidence |
|---|---|---|
| 1 | Zero open Critical or High findings, from any source | VAPT report plus retest confirmation |
| 2 | Every Medium has an owner, a date and an accepted risk record | Vulnerability register |
| 3 | All CI gates green on the release commit | Pipeline run, retained |
| 4 | SBOM produced, no Critical or High CVE without documented mitigation | CycloneDX artefact |
| 5 | Threat model current for the release | Reviewed model, dated |
| 6 | ASVS L2 mapped platform-wide; L3 on the elevated paths | Verification matrix |
| 7 | NCA ECC and SAMA CSF control mappings complete, gaps accepted by name | Compliance matrix |
| 8 | Penetration test by an NCA-licensed provider, scope including §2.1 | Signed report |
| 9 | **All §2.1 abuse cases attempted and failed** | Named results per abuse case |
| 10 | Infrastructure hardened to CIS, drift monitored | Benchmark report |
| 11 | Incident response plan tested within 12 months | Exercise record |
| 12 | DR/BCP tested against RPO 15 min / RTO 4 hours | Test record |
| 13 | No production data in any non-production environment | Attestation plus automated check |
| 14 | Security awareness training current for all personnel with access | Training record |

**SEC-C02** Sign-off is **per release**, not perpetual. A material change invalidates it.

> **A note worth making to the client.** "Bug free and vulnerability free" is not an achievable
> state and no credible provider will certify it. What is achievable, and what a regulator
> actually expects, is a **demonstrably controlled** state: known posture, bounded exposure,
> enforced gates, defined SLAs, independent verification, and evidence. Promising the former
> creates a liability; delivering the latter passes audit. This document specifies the latter.

---

## 6. Runtime security

| Ref | Control |
|---|---|
| SEC-O01 | WAF in front of every public surface, tuned, in blocking mode before go-live |
| SEC-O02 | Rate limiting and anti-automation at the gateway and the application, per principal and per tenant |
| SEC-O03 | Centralised in-Kingdom logging to a SIEM, with use cases for the §2.1 abuse cases — a gate-bypass attempt must alert, not merely log |
| SEC-O04 | EDR on all hosts and nodes |
| SEC-O05 | Runtime container security: read-only root filesystem, non-root user, no privileged containers, dropped capabilities, admission control |
| SEC-O06 | Network segmentation by trust zone with default-deny egress; signing and key material in a restricted zone |
| SEC-O07 | Secrets dynamically issued, short-lived, rotated on a schedule and on personnel change |
| SEC-O08 | Key management in an HSM, in-Kingdom, with documented rotation, escrow and destruction |
| SEC-O09 | Continuous cloud posture management with drift alerting |
| SEC-O10 | Integrity monitoring on the audit chain — periodic independent verification that the hash chain validates end to end |

---

## 7. Vulnerability management

**SEC-M01** A single vulnerability register across all sources: SAST, SCA, DAST, pen test, bug
bounty, internal discovery, vendor advisory. One register, one SLA clock, one owner per item.

**SEC-M02** Monitoring of vendor advisories for every component in the SBOM, including Tuum,
Nutrient, Supabase, IBM API Connect and every KSA rail.

**SEC-M03** Emergency patch path capable of production deployment within 24 hours, tested.

**SEC-M04** Monthly security posture reporting to the client CISO: open findings by severity and
age, SLA adherence, gate pass rates, incidents.

---

## 8. Incident response

**SEC-I01** Documented IR plan covering detection, triage, containment, eradication, recovery and
lessons learned, with named roles and a 24/7 contact path.

**SEC-I02** Regulatory notification timelines satisfied — **SAMA, NCA and SDAIA each have their
own**, and they differ. Confirm current requirements with the client's compliance function and
build the clock into the runbook.

**SEC-I03** A Shariah dimension: an incident that produces a non-compliant transaction triggers
the Shariah incident process and the purification workflow in parallel with technical response.
Technical containment alone is not resolution.

**SEC-I04** IR exercised at least annually, including one scenario drawn from §2.1.

---

## 9. Immediate gaps in the current repository

Assessed 2026-10-08. These are present-state findings, not future requirements.

| # | Gap | Severity | Action |
|---|---|---|---|
| 1 | **No security scanning in CI whatsoever.** `gateway.yml` and `ibm.yml` contain no SAST, SCA, secrets, container or IaC scanning. | **High** | Add `.github/workflows/security.yml` (provided) |
| 2 | No security content in `CLAUDE.md` | High | Add a security section referencing this document |
| 3 | Gitleaks does not run over history — the pre-commit hook scans staged content only, so anything committed before the hook was enabled is unscanned | High | Full-history scan, once, then in CI |
| 4 | 36 compiled `.js` files tracked alongside `.ts` sources | Medium | Build in CI; remove from the repository |
| 5 | No SBOM | Medium | Generate per release |
| 6 | No threat model | Medium | STRIDE workshop; §2.1 is the starting input |
| 7 | No dependency pinning by SHA in workflows | Medium | Pin actions to commit SHAs |
| 8 | PCI DSS applicability undetermined for BNPL / embedded modules | **Open** | Decide before building card-adjacent flows |
| 9 | NCA ECC and CSCC applicability undetermined | **Open** | Confirm with client CISO — CSCC materially raises the bar |

---

## 10. Open items for the client CISO

| Ref | Question |
|---|---|
| SEC-Q01 | Is Sanad classified a **critical system**? Determines whether NCA CSCC applies. |
| SEC-Q02 | Target **SAMA CSF maturity level**? Assume 3 until told otherwise. |
| SEC-Q03 | Does any module touch **cardholder data**? Determines PCI DSS scope. |
| SEC-Q04 | Which **NCA-licensed provider** performs VAPT, and is the client's existing panel usable? |
| SEC-Q05 | Does the client's **SOC** monitor this platform, or is monitoring IOTA's responsibility? |
| SEC-Q06 | Client's **regulatory notification timelines** and contacts for SAMA, NCA and SDAIA. |
| SEC-Q07 | Is a **bug bounty or responsible disclosure** programme in scope? |
| SEC-Q08 | **Who signs** the clean chit, and do they accept the §5 definition? Agree before testing. |
