# SANAD

**Sanad** (سند) — Shariah-compliant origination platform.
**Wasl** (وصل) — its first product: SME supply chain finance for the Kingdom of Saudi Arabia.

Wasl is not a lending system with a compliance layer. It is a **trading system that
produces a financing outcome**: the institution buys goods, takes title, bears ownership
risk for an evidenced interval, and sells them on at a disclosed markup. That is why the
domain model has goods, ownership, possession and custody as first-class things, and why
there is no interest construct anywhere in it.

## Read first

| | |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Build instructions and the non-negotiable invariants. Read before writing code. |
| [`docs/Sanad-Wasl-Solution-Design-v0.2.pdf`](docs/) | The specification — BRD, HLD, architecture, data, backend, frontend. |
| [`docs/SAVING-CREDENTIALS.md`](docs/SAVING-CREDENTIALS.md) | How to store the partner API keys. |

## Layout

```
core/         domain. No client name, no vendor name, no clock read, no rate.
  kernel/       Result with control codes; Money as minor-unit bigint
  time/         attested instants from a timestamping authority
  structures/   declarative structure definitions and their validator
  sequencing/   the state machine, the transitions, the pure gate evaluator
  evidence/     typed evidence; append-only, superseded never edited
  legs/         one leg, one document, hash-chained
  pricing/      sale price = cost + profit, and nothing else
  obligation/   the total, the schedule, and the one-directional waiver
  ledger/       the segregated charity liability
  decisioning/  the credit policy language, engine, snapshot and decision record
  parties/      counterparty distinctness on registration numbers
  trade/        the financed invoice registry
  documents/    render requests — exactly one leg each
  authz/        the closed entitlement catalogue
  ports/        capability-named interfaces the adapters implement

adapters/     one per external system. Vendor vocabulary stops here.
  kernel/       circuit breaker, failure posture, credential handling, fixtures
  tuum/         core banking            — see its README for deviations
  nutrient/     documents and signature — see its README for deviations

config/       data, not code. Per tenant, versioned, effective-dated.
  tenants/bank-a/       structure definition + credit policy
  tenants/fintech-b/    the same, with a different Board and a different Credit function

supabase/     migrations, constraints, triggers, row-level security
test/
  compliance/   the adversarial suite — each test passes only when the attempt fails
  architecture/ the absences: no rate, no clock, no vendor in core
  adapters/     partner integrations against recorded fixtures
  unit/         decisioning
```

## Stack

Next.js · Node + TypeScript · Kong (abstracted for IBM API Connect / DataPower) · Redis ·
Supabase (PostgreSQL) · a durable workflow engine for sequencing (**not yet selected** —
see below)

## Setup

```bash
npm install
npm run verify        # typecheck + the full suite
supabase db push      # apply migrations
```

Then store the provider credentials — see [`docs/SAVING-CREDENTIALS.md`](docs/SAVING-CREDENTIALS.md).
**Never commit a key.**

## Guard rails

A `PreToolUse` hook ([`.claude/hooks/invariant-guard.py`](.claude/hooks/invariant-guard.py))
blocks edits that introduce a rate construct, place a domain table in the exposed schema,
hardcode a credential, or read the server clock inside `sequencing/`. It matches
`Edit|Write|NotebookEdit` and does **not** see shell writes, so file changes to code should
go through those tools.

The same invariants are enforced three more times, which is deliberate — a single layer of
enforcement is a single point of failure:

| Invariant | Type system | Service layer | Database | Test |
|---|---|---|---|---|
| No sale before the gates (SH-05/06) | transitions are not callable | gate evaluation | `check` on `sale_offered_at` | adversarial |
| Total never increases (SH-02) | — | schedule validation | deferred constraint trigger | adversarial |
| One leg, one document (SH-07) | request holds one leg | `appendLeg` | `unique (document_id)` | adversarial |
| No duplicate financing (SH-10) | — | pre-flight check | `unique (tenant_id, invoice_uuid)` | adversarial |
| Late charges are not income (SH-13) | one account class | `postLateAmount` | single-valued `check` | adversarial |
| No rate exists (SH-01) | no such field | no such field | no such column | source scan |

## Open questions that affect the build

These are flagged rather than assumed away.

1. **Data residency vs. Supabase.** NFR-05, RC-03 and AP-09 require in-Kingdom storage
   without exception. Supabase has no Saudi region. The schema is portable PostgreSQL, so
   this does not block building — but the position needs stating: Supabase for development
   and design-partner work, self-hosted in-Kingdom PostgreSQL for the bank deployment.
   Related: Vault's encryption key must move to a customer-managed key in an in-Kingdom HSM
   (already noted in `docs/SAVING-CREDENTIALS.md`).
2. **Durable workflow engine not selected.** SDD §6.1 names Temporal or equivalent;
   CLAUDE.md §3.4 rules out Edge Functions for sequencing but names no replacement.
   Sequencing spans hours to days and needs deciding before the engine is wired up.
3. **Row-level security needs a non-bypassing role.** Migration `0003` creates `sanad_app`
   (`nobypassrls`) and the policies key off `current_setting('sanad.tenant_id')`. The
   service layer must connect as that role and set the GUC per request from the
   authenticated principal — otherwise the policies are documentation rather than isolation.
4. **Both partner API surfaces are unverified** (OI-02, OI-05, OI-06). The adapters are
   real; their transports are placeholders whose endpoint paths and payload field names are
   supplied as configuration, precisely because they are unknown. See each adapter's README.

## Status

Pre-Phase-0. The design is not frozen: it is subject to the rulings of each deploying
institution's Shariah Supervisory Board, and to the open items in Section 9 of the SDD.
Where this repository takes a position on a contested point, it takes it as **configuration**
— see `config/tenants/`, where the two institutions already differ on the risk-holding
interval, on what evidence discharges possession, and on how a limit is sized.
