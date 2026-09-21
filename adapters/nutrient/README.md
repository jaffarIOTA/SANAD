# Document platform adapter — Nutrient

Implements three capability interfaces from `core/ports/documents.ts`:

| Interface | What it covers |
|---|---|
| `DocumentRenderingProvider` | Bilingual generation, template version binding, drift comparison, long-term archival |
| `SigningProvider` | PAdES with long-term validation on the master agreement; institutional seal on each leg |
| `DocumentIntelligenceProvider` | Extraction from unstructured evidence with confidence scoring, and rule-driven redaction |

Three interfaces rather than one because an institution may satisfy them with three
products. They live in one adapter here because one product satisfies all three today.

## Deployment

**Self-hosted, in-Kingdom, inside the same trust boundary as the application.** Not
consumed as an external service. Contract documents carry national identifiers, commercial
terms and signatures, and NFR-05 admits no exception — including for logs and backups.
This is the requirement that makes the residency position defensible (SDD §4.8), and it is
the reason this platform fits at all.

## Verification status

Unverified, as with the core banking adapter. Two Phase 0 spikes must complete before
design freeze:

- **OI-05 — Arabic rendering fidelity.** Render the most complex real template: mixed
  Arabic and English, tables, both calendars side by side, Arabic-Indic and Latin numerals.
  Legal reads the output. Arabic is the governing contractual text, so this is a
  correctness requirement, not typography.
- **OI-06 — a validated signed document.** Obtain a test certificate from the selected
  licensed certification service provider and produce one long-term-validation PDF that
  verifies. **Until that file exists the signature design is a hypothesis.**

Neither spike is closed. Treat the transport shapes here as assumptions.

## Known deviations

### `NUTR-DEV-001` — confidence as a floating point score

Extraction confidence is conventionally a float in [0,1]. Floating point is barred from
the financial path (BE-06), and while a confidence score is not a financial value, letting
one float into the codebase invites the next one.

**Containment.** The port expresses confidence as `confidencePerTenThousand`, an integer.
The adapter converts at the boundary, rounding **down**, so a borderline extraction is
treated as the lower confidence and routes to an operations queue rather than discharging
a gate.

### `NUTR-DEV-002` — locked regions are a template convention, not an API guarantee

BR-G02 requires that the rendering engine be *incapable* of altering a Board-approved
clause. If the vendor enforces this only by convention, the adapter must enforce it
instead: it rejects any render whose merge fields are not a subset of the template
version's declared merge field names, before the call is made.

That check is implemented. Whether the vendor also enforces it is an OI-05 question.

## Failure posture

`QUEUE` for rendering — transactions proceed to the point requiring a document, then hold,
and the user sees an honest pending state rather than a spinner.

`FAIL_CLOSED` for signing and timestamping. No leg executes without a trusted timestamp
and a valid seal. Compliance dependencies never degrade (SDD §4.9).
