# Nutrient — verification runbook

Two intended uses: **document intelligence** over the evidence an applicant uploads
(digitise, classify, extract, with a confidence score), and **digital signatures** on the
contract set, the promissory note first among them. Neither is verified. This file is the
list of checks that turn the adapter's assumptions into findings, in the order the
findings are needed.

## Check 0 — the adapter without the vendor (runs today)

```bash
npx vitest run test/adapters/nutrient-document.test.ts
```

Seventeen cases against a scripted transport: explicit template version or nothing, no
substitution into an undeclared field, confidence floored and never rounded up, a
signature refused without a verified timestamp or when the signed hash differs, an empty
redaction set treated as a refusal, the saved credential key name, the token in no
outcome, and the breaker opening after the threshold. Green here means the adapter keeps
its own promises. It says nothing about the vendor — that is what V-01 to V-08 are for.

## What is required before the first check

| | Needed | Why |
|---|---|---|
| 1 | **Licence scope decided (R-02)** — Web SDK alone, or Web SDK **with Document Engine** | The two are different architectures. Web SDK alone runs in the browser; a document processed there is processed on the applicant's phone, and every rule in CLAUDE.md §5 ("no rail is called from the browser", "snapshots, not copies") points the other way. Both uses here are server-side: extraction must produce evidence the engine can trust, and a signature must be applied by the institution, in the Kingdom, with a timestamp from the TSA. **Recommendation: Web SDK with Document Engine, self-hosted.** The Web SDK stays as the viewer and the signing *ceremony* in the ops and consumer apps; Document Engine does the work. |
| 2 | **Document Engine running in-Kingdom** (container; its activation key in the container's environment) | The residency position depends on it (README, "Deployment"). For the first check a developer's laptop is acceptable; nothing real goes through it. |
| 3 | **Four credentials saved** — see `docs/SAVING-CREDENTIALS.md` | `web_sdk_license_key`, `document_engine_base_url`, `document_engine_api_token`, `jwt_private_key`. Vault when the database is reachable; `.env.local` under the `SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_*` names until then. |
| 4 | **A test signing certificate** from the selected licensed certification service provider (OI-06), and the TSA (E-04) | Without these the signature check can only prove plumbing. A self-signed certificate is enough to prove the plumbing and nothing more; the README must say which it was. |
| 5 | Three sample documents, **synthetic** — a delivery note, a commercial invoice, an Iqama-shaped identity page with fabricated data | Never a real applicant's document, not even in a sandbox. The point is the shape, not the person. |

## The checks, in order

Each has one question it answers. Record the answer in the README's verification section
with the date and the Document Engine version. A check that could not be run is recorded as
not run, not skipped.

### V-01 — the licence activates
Load the Web SDK in `apps/ops` with the licence key from the credential provider, on the
development origin. **Question:** does the key accept this origin, and what does the SDK
report as the licensed feature set (forms, electronic signatures, digital signatures,
redaction, document editor)? The feature list decides which port methods have a vendor
behind them.

**Run 2026-10-02, without a licence key** (`@nutrient-sdk/viewer` 1.22.0, assets served
same-origin from `apps/ops/public/nutrient/`): the SDK loads in evaluation mode and renders
the synthetic commercial invoice at `/en/documents/sample-commercial-invoice` with the
"For Evaluation Purposes Only" watermark; the page reports "evaluation mode — no licence
key". So the viewer path works end to end on this origin; the licensed feature set is
still unanswered until the key is saved under `web_sdk_license_key` and the page is
reloaded.

**Run 2026-10-03, with the demo key** (saved through the admin app into the vault; the ops
viewer read it from the vault, source `VAULT`, and reported "licence active"): the SDK
accepted the key's form and refused to initialise — console: *"Nutrient Licensing Issue:
Your Nutrient demo key expired (valid until 2026-09-17 03:00:00)"*. So the vault → viewer
path is proven end to end, the key is read and presented correctly, and **the key itself
is expired**. V-01 completes when Nutrient issues a current key; rotate it under the same
name in the admin app and reload. Two vendor warnings recorded for later: the SDK prefers
`preloadWorker()` before `load()` (now done), and copying assets out of the npm package is
deprecated in favour of the vendor's self-hosting guide.

### V-02 — Document Engine answers
Start the stack in `adapters/nutrient/compose/` (its README has the four commands), then
`GET {base_url}/healthcheck`, then an authenticated call with the API token. **Question:**
is the engine reachable from the server only (not from the browser), and does the token
authenticate? Confirm the current authentication header form against the vendor's
Document Engine API reference before encoding it in the adapter.

### V-03 — a document round-trips
Upload one synthetic PDF, read back its metadata, fetch the rendition, hash it. **Question:**
does the hash of what came back equal the hash of what went up? That equality is what
`RenderedDocument.contentHash` and "what is signed is what was seen" (BR-G06) rest on.

### V-04 — one digital signature that validates (OI-06)
Sign the uploaded document through Document Engine with the test certificate, request
long-term validation material, download, validate with an independent validator (not the
vendor's own). **Question:** is the result PAdES with LTV, with the chain and the timestamp
both valid? Until one such file exists the signature design is a hypothesis (README).
Record: certificate issuer, profile reported, validator used, result.

### V-05 — the promissory note as a form
Render the promissory-note template as a PDF form: payee, amount in figures and in words
(Arabic governing, English accompanying), both calendar dates, place of payment,
signatory. Fill it through Document Engine, flatten, sign as in V-04. **Question:** can the
amount-in-words field be filled only from the server, and does flattening leave no
editable field? A promissory note with a live field is not a promissory note.
The legal form itself is for counsel to confirm against the Commercial Papers Law and the
enforcement-court requirements; this check proves the production path, not the
instrument.

### V-06 — extraction on the three samples
Run document intelligence on each synthetic sample. **Question:** what does the engine
return — a document class, named fields, a confidence per field? Record the exact shape.
The adapter floors confidence to an integer per ten thousand, rounding down
(`NUTR-DEV-001`); confirm the vendor's scale (0–1 or 0–100) before the conversion is
trusted. Record which fields it found on the Arabic sample; Arabic extraction fidelity is
OI-05's question for intelligence as well as rendering.

### V-07 — the browser never holds a secret
With the viewer open, inspect what reached the browser: the licence key (expected) and a
short-lived JWT signed by the server (expected), and nothing else. **Question:** is the
Document Engine API token absent from every response, bundle and header the browser saw?

### V-08 — redaction holds
Redact the identity-number field on the identity sample for recipient class
`EXTERNAL_COUNSEL`, download, search the bytes. **Question:** is the value gone from the
file, not merely covered?

## Where the pieces are

| | |
|---|---|
| Adapter (ports → operations) | `adapters/nutrient/document-adapter.ts`, tested without the vendor in `test/adapters/nutrient-document.test.ts` |
| Live transport (operations → engine HTTP) | `adapters/nutrient/live-transport.ts`; every route names the check that confirms it |
| Viewer token (browser → engine, no API token) | `adapters/nutrient/viewer-token.ts` |
| Local Document Engine | `adapters/nutrient/compose/` + `scripts/nutrient-dev-keys.sh` |
| Viewer in the workbench | `/[locale]/documents`, assets by `npm run nutrient:assets` |
| Synthetic samples | `npm run nutrient:samples` → `adapters/nutrient/verification/samples/` (gitignored) |

## After the checks

- Update `adapters/nutrient/README.md` → "Verification status" with each V-nn result.
- If V-04 produced a validating file, OI-06 closes; `apps/ops/src/server/modules.ts`
  `signature` moves from `BLOCKED` to the next honest state.
- If V-01 showed Document Engine is licensed, R-02 is answered; `generated` unblocks.
- Any shape the engine returned that the adapter's transport does not expect becomes a
  fixture in `test/adapters/` before the adapter changes.

## What this does not decide

Whether electronic acceptance of a leg is valid execution (OI-04), which certification
service provider the institution contracts (BR-G04), and the promissory note's legal form.
Those are Board, procurement and counsel decisions; the checks above only prove the path
exists.
