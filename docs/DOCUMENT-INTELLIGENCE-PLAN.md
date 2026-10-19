# Document intelligence: plan

**Status:** accepted, 19 October 2026. Milestones D1–D5, built before Wasl W4b.

**Product owner's decisions (19 October 2026):**
- **Engine:** build now on the in-house Document Engine (Nutrient) with configured rules. The port is designed so an
  AI model can be plugged in as a second adapter once the AI infrastructure is ready.
- **Acceptance:** always four eyes. A finding assists the checker; nothing is ever accepted without a second person.
  D5 delivers the throughput view only.
**Why now:** the document path is still young. One shared layer added now is cheaper than retrofitting it into each
journey once the journeys have settled.
**Benchmark:** Noxus's loan document processing use case (intake, completeness, validation, gap requests, a clean
file for the underwriter, an audit trail). The gap analysis is at the end.

## The principle: one layer, called by every journey

Each journey (SME business applications, Wasl origination requests, later consumer) already has the same three
moments:

1. **Presented.** A file arrives (`presentDocument` / `uploadBusinessDocument`; `attachDocument` for Wasl).
2. **Validated.** A different person decides VALID or INVALID (`validateDocument`, four eyes).
3. **Counted.** The checklist reports present, missing, expired, invalid or pending (`core/documents/checklist.ts`),
   and the journey's gate refuses an incomplete pack.

Document intelligence adds one thing between moments 1 and 2: **findings.** For each presented document, the system
records:
- what the document is (its classification);
- what it says that matters;
- whether it passes the checks its checklist item declares.

The checker sees the findings beside the document. Journeys change by one call each. They do not change their state
machines, gates or four-eyes rules.

```
upload ─▶ store (object store, unchanged)
       ─▶ understand (new port)  ─▶ findings (new, append-only)
                                      ├─ classification: type, confidence
                                      ├─ facts: dates, period, matches (results, not raw values)
                                      └─ checks: PASS / FAIL / UNREADABLE per declared rule
       ─▶ checker validates (unchanged, now with findings in view)
       ─▶ checklist counts (now dated from the document itself where it was read)
```

## Rules that hold throughout

- **Snapshots, not copies (CLAUDE.md §5).** A finding stores the decision-relevant result: the document's issue
  date, its expiry date, "the name matches the applicant: yes or no", the reference it was checked under. It never
  stores the national ID number, the name, the address or the salary read off the page. Those stay inside the
  document, in the object store.
- **No personal data in logs, events or errors.** Findings name check codes and outcomes only.
- **A finding informs; it never decides.** A failed check is shown to the checker with its reason and is never an
  automatic refusal. A passed check is never an automatic acceptance: every document is still validated by a person
  other than the one who presented it.
- **Official records outrank documents.** Where a rail answers the same question (identity from Yakeen and Nafath,
  company status from Wathq, salary from GOSI, statements from Open Banking, credit from SIMAH), the rail's answer
  governs. The document check is corroboration and a fallback.
- **Ports and configuration, not code paths.** Document types, their markers in Arabic and English, the fields read
  and the checks applied are tenant configuration. The engine sits behind `DocumentUnderstandingPort`.
  - The first adapter is rules over the Document Engine's text.
  - An AI model is a second adapter returning the same findings, selected per tenant in configuration.
  - Findings record which engine and version produced them, so the two can be compared on the same documents
    before switching.
- **Residency.** Documents are read on the institution's own hosts (the document engine already runs there). An AI
  adapter may be selected only where the deployment profile declares an approved in-Kingdom model host, or on
  synthetic data. Anywhere else the configuration refuses it.

## Milestones

### D1: findings and classification (foundation)

- `core/documents/understanding.ts` (pure):
  - the `DocumentFindings` type (classification, facts, checks, source FIXTURE or LIVE);
  - the classifier and field readers, run over the extracted text against the tenant's document-type definitions.
- `core/ports/document-understanding.ts`: `understand(pdf | image) → findings`.
  - The first adapter composes the existing extraction port (Nutrient Document Engine text and tables) with the
    rules above.
  - Fixture transport for tests.
- Configuration: `config/tenants/<t>/documents/document-types.json`. Per type: its markers (Arabic and English), the
  facts to read (issue date, expiry date, statement period, registration number, holder name to match), and the
  confidence floor below which a reading counts as UNREADABLE.
  - First types: commercial registration, national ID, national address, bank statement, payslip, articles of
    association, VAT and zakat certificates.
- Migration: `evidence.document_finding`. Append-only, tenant-scoped with RLS, superseded rather than updated, keyed
  to the presented document's reference and hash.
- Business journey: findings are produced on upload. The officer sees "this looks like a bank statement, not a
  commercial registration" before submitting it under the wrong type. The checker sees the findings.

### D2: checks on what the document says

- Check rules declared per checklist item (configuration), evaluated by a pure function:
  - **recency:** the statement period ends within N days of submission; the payslip month is within N;
  - **validity:** the document's own expiry date is after the submission date, or after the facility's term where
    the item says so;
  - **coverage:** a statement covers at least N months;
  - **match:** the holder name or registration number on the document matches the application's party. Names are
    normalised for Arabic and Latin script, and only the yes/no result is stored;
  - **corroboration:** the document agrees with what the rail returned (the CR number with Wathq, the salary band
    with GOSI). Where they disagree, the rail governs and the finding says so.
- ~~The checklist dates an item from the document's own date where D1 read it, and from the upload otherwise.~~
  **Withdrawn when D2 was built (19 October 2026).** Counting expiry from a date the machine read would make the
  reading a decision, against "always four eyes". The checklist still dates an item from its capture and counts the
  checker's validation, exactly as before. A content check is shown to the checker and changes nothing on its own.
- The checker's screen shows each check: PASS, FAIL with what was seen and the limit, in both languages, or
  UNREADABLE (never shown as a failure).

**As built (D2):**

- **Rules** live in `core/documents/document-checks.ts` and are declared per checklist item as `checks`:
  `NOT_EXPIRED` (optional `minimumRemainingDays`), `ISSUED_WITHIN`, `PERIOD_ENDS_WITHIN`, `PERIOD_COVERS`,
  `REGISTRATION_MATCHES` and `NAME_FOUND`. They're ILLUSTRATIVE in every tenant's checklists.
- **Reading date:** the institution's civil date at the moment of reading. Hijri dates convert on Umm al-Qura. A
  date that isn't a real calendar day is UNREADABLE.
- **Registration number and name:** compared while the text is in hand; only MATCHES/DIFFERS or FOUND is kept. A
  name that isn't found is UNREADABLE, not FAIL, because rendered Arabic may simply not have been read (V-06).
- **Wrong type:** a document that doesn't read as the type presented has every content check UNREADABLE.
- **Corroboration with the rails** (Wathq, GOSI) is not built. It waits on those rails' live verification.

### D3: authenticity

- Wire the Tahaqoq adapter (built, unused) through `DocumentVerificationPort` for national digital documents.
- It is consent-gated (CLAUDE.md §5) and its result is recorded as a finding.
- A "not authentic" answer is a finding the checker must resolve; it never silently passes.
- Live use waits on KSA-RAIL-TAHAQOQ-01.

### D4: gaps and resume

- `gapsOf(checklist report, findings)`: what is missing, expired, unreadable or failing a check, in words the
  applicant can act on (Arabic and English).
- "Request the missing documents": a `NOTIFICATION` on the transactional outbox to the applicant's party reference,
  or the broker's, through the notifications port. It is idempotent per gap set.
- When a document arrives that closes the last gap, the application records it and the officer's queue shows the case
  as ready again. Where a journey has a waiting state (the Wasl request's AWAITING_INFORMATION), it resumes.

### D5: measurement

- Throughput view, derived from events:
  - documents classified correctly at the first attempt (the checker's decision against the classification);
  - checks passed and failed, by type;
  - touchpoints per application;
  - time from first upload to a complete pack;
  - how often the checker agreed with the findings.
- No automatic acceptance (product owner, 19 October 2026). This view is what would inform revisiting that decision.

## What does not change

Every journey's states, gates, four-eyes rule, decision pack and audit trail stay as they are.
The upload path, the object store, statement figure reading (V-06) and the checklist's format all stay.
D2 extends the checklist with optional check rules: existing checklists with none behave exactly as today.

## Dependencies and verification

- Nutrient extraction on real Saudi samples, in Arabic and English: V-05, V-06 (`adapters/nutrient/verification`).
  Until they are verified live, D1–D2 run on the fixture transport, labelled.
- A set of synthetic document samples per type for the test suite, in both scripts.
- Tahaqoq sandbox access (KSA-RAIL-TAHAQOQ-01) for D3 live.
- Notification credentials per tenant for D4 live.

## Gap analysis against the benchmark

| Feature | Before | After |
|---|---|---|
| Pack chosen by product | Yes | Yes |
| Completeness before review | Yes | Yes, plus findings-driven gaps |
| Classification of uploads | Staff choose the type | D1 |
| Extraction | Bank statements only | D1 (named types) |
| Recency and expiry from the document | Dated from upload | D2 |
| Name and address against the application | Rails only | D2, results only |
| Authenticity | Adapter unused | D3 |
| Gap requests and resume | Manual | D4 |
| Straight-through processing | Never (four eyes) | Never, by decision; the checker works from findings |
| Throughput metrics | None | D5 |
| Audit and replay | Yes | Yes, findings included |
| Arabic and residency | Yes | Yes |
