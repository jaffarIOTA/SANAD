# Claude's recommendations

A standing register of everything I have flagged, recommended, or deliberately not
done, so none of it lives only in a chat transcript.

**Status:** open for review. Nothing here has been agreed.

---

## How to use this file

Each item has a stable identifier (`R-01`, `E-03`, …). Identifiers are never
reused, so a decision recorded against one stays meaningful.

To answer, add an `Ans:` line under the item, exactly as in
[docs/open-questions.md](docs/open-questions.md):

```
Ans: Agreed. Use the managed in-Kingdom Postgres, not self-hosted. Owner: Faisal, by 15 Oct.
```

I will read those, act on what is actionable, and move the item to **Closed** with
a note pointing at the commit or ADR that settles it. If an answer changes a
design decision, it becomes an ADR in `docs/adr/` — this file is the queue, not
the record.

**Severity**

| | Meaning |
|---|---|
| **Blocking** | Work is stopped, or will produce rework if we guess |
| **Material** | Real consequence, has a workaround, needs a decision before UAT |
| **Hygiene** | Should be fixed, no one is at risk today |

---

# A. Environments — UAT, pre-production, production, DR

This section exists because the environment topology is currently undecided below
the level of [ADR 0001](docs/adr/0001-data-residency-and-datastore.md), which
settled *what the datastore is* but not *how many environments there are or what
each is allowed to hold*.

## E-01 — There are five environments, not three · **Blocking**

The code currently recognises three. `config.integration_credential.environment`
is constrained to `('sandbox', 'uat', 'production')`
([0001_integration_credentials.sql:57](supabase/migrations/0001_integration_credentials.sql#L57)).

There is no value for **pre-production** and none for **DR**. That is not a
cosmetic gap: it means a pre-production deployment today must either reuse UAT
credentials or reuse *production* credentials, and both are wrong. Reusing
production credentials in a non-production environment is the §10 prohibition
arriving through the back door.

**Recommendation.** Five environments, with a settled classification:

| Environment | Holds real data | Credential scope | Purpose |
|---|---|---|---|
| `development` | No | fixtures only | Local. Supabase. |
| `sandbox` | No | vendor sandbox | Integration against vendor sandboxes. Supabase. |
| `uat` | No — synthetic only | vendor UAT | Client acceptance. **First in-Kingdom environment.** |
| `pre-production` | No — synthetic, production-shaped | vendor pre-prod | Production-identical topology. Release rehearsal and DR drills. |
| `production` | Yes | vendor production | |
| `dr` | Yes | **shares production's** | Not a separate environment so much as production's second site. |

Two consequences worth stating plainly:

- **DR is production.** It holds real data under real controls. It is not a
  "lower" environment and must not be treated as one — same access control, same
  logging, same residency, same object lock. Giving DR its own weaker credential
  set is how a DR site becomes the softest target in the estate.
- **Pre-production must be configuration-identical to production, including the
  gateway implementation.** This is where we find out whether the client runs Kong
  or IBM API Connect (§5). Discovering that in production is not a discovery, it
  is an incident.

**Action:** widen the check constraint to the five values, and add a migration
that refuses `production_data_permitted = true` for anything except `production`
and `dr`.

Ans:

## E-02 — DR has no stated RPO or RTO, and the usual answers are wrong here · **Blocking**

A conventional "RPO 15 minutes" is not survivable for this system, because two
of our datasets are not ordinary application data.

**Evidence and audit are append-only and hash-chained** (§3.2). A restore that
loses the last *n* rows does not lose *n* rows of history — it breaks the chain,
and a broken chain cannot be replayed by the Shariah audit process (SH-18). The
damage is not proportional to the data lost.

**Recommendation.**

- **RPO 0 for `evidence` and `audit`.** Synchronous commit to the standby for
  those schemas at minimum. Asynchronous replication is acceptable for
  `config` and for read models; it is not acceptable for the chain.
- **RTO measured against the sequencing engine, not the API.** A Murabaha
  sequence spans hours to days across external systems — the reason Edge
  Functions were rejected for it (§3.4). The durable workflow's state must fail
  over *with* the database, so it should be stored in the same PostgreSQL
  cluster rather than in a separate engine with its own replication story.
- **A DR drill must include a gate replay**, not just a "the site came up" check.
  Take the evidence set from before failover, re-run gate evaluation on the
  recovered site, and assert identical results. This is only possible because
  gate evaluation is a pure function of (transaction, evidence set) with no I/O
  and no clock read (§1.3) — it is the strongest integrity test available to us
  and it costs almost nothing to run.

Ans:

## E-03 — Failover cannot move a gate, and that is by design · *(no action — record it)*

Worth writing down because it will come up in a DR review and the answer is good.

The risk-holding period is measured against an external timestamping authority,
never `new Date()` (§1.3, §10). So a failover to a site with skewed clocks, a
restore to an earlier point in time, or a region with a different time source
**cannot advance or retard a sequencing gate**. Clock skew is an ordinary
availability problem here, not a Shariah one.

The dependency this creates is on the TSA — see E-04.

Ans:

## E-04 — The timestamping authority is an unprocured, hard dependency · **Blocking**

No TSA, no `TsaInstant`. No `TsaInstant`, no Gate 3. No Gate 3, no sale leg. The
entire product stops at `POSSESSION_CONFIRMED`.

We have a branded type that can only be constructed from a verified attestation,
which is the right design — and currently it is fed by fixtures. I have not seen
a decision on who the accredited authority is, and it is not in ADR 0001's action
list.

**Recommendation.** Treat the TSA as a Phase 0 procurement alongside in-Kingdom
PostgreSQL, and specify per environment:

- UAT onward must use an **accredited** authority, not a test service — an
  acceptance test signed against a toy timestamp proves nothing about production.
- Production and DR need **separate credentials but the same authority**, so a
  failover does not change whose attestation the chain carries mid-transaction.
- Define the behaviour when the TSA is unreachable. My recommendation: the
  sequence **stalls**, visibly, and never proceeds on a local clock. A queued
  transaction waiting for a timestamp is an operational problem; one that
  advanced a gate without an attestation is a regulatory one.

Ans:

## E-05 — Executed documents cannot live in Supabase Storage past development · **Material**

Already stated in CLAUDE.md §3.3, restated here because it is an environment
provisioning item that nobody has been assigned.

Supabase Storage provides no write-once retention. The retention obligation is
statutory. From UAT onward, executed documents and evidence artefacts need
S3-compatible in-Kingdom storage **with object lock**.

For DR specifically: **the replica must preserve the lock.** A cross-region copy
into a bucket without object lock is a compliance gap wearing a durability
costume — it satisfies "we have a second copy" and fails "the copy cannot be
altered".

Ans:

## E-06 — UAT needs a synthetic data strategy, and nobody owns it · **Material**

§10 forbids production data in a non-production environment, without exception.
UAT is where a client's acceptance team wants realistic volumes and realistic
edge cases, and the path of least resistance is a masked production extract.
Masking is not sufficient here: CR numbers and invoice UUIDs are the keys that
SH-08 (counterparty distinctness) and SH-10 (duplicate financing) match on, so
masking them changes the behaviour under test, and *not* masking them means
production data in UAT.

**Recommendation.** Generate synthetic counterparties, CRs and cleared-invoice
UUIDs from a seeded generator, checked into `config/`, so UAT scenarios are
reproducible and carry no real entity. Budget it as real work — it is roughly a
week, and it is the only lawful way to get a realistic UAT.

Ans:

## E-07 — Residency must be a continuous control, including log sinks · **Material**

ADR 0001 lists this as an open action. Naming the specific traps, because they
are the ones that get missed: **log sinks, error trackers, APM/tracing backends,
backup destinations, the analytical store, and any email or SMS provider**. Every
one of those is a data processor and every one defaults to a non-Kingdom region.

An error tracker with default settings will exfiltrate request bodies to a US
region, which is simultaneously a residency breach and, given §4, a potential
credential leak.

Ans:

## E-08 — ADR 0001 contains a factual error about role revocation · **Hygiene**

[ADR 0001](docs/adr/0001-data-residency-and-datastore.md#L45) says revoking a
role that does not exist is "a no-op". It is not — PostgreSQL raises an error, so
migrations `0003` and `0004` would have failed outright on the first self-hosted
deployment, which is to say on the first UAT deployment.

This was found and fixed with `core.hosted_platform_roles()`
([0003_core_domain.sql:37](supabase/migrations/0003_core_domain.sql#L37)), but
the ADR still records the wrong reasoning. Correct it, because the next person
reading the ADR will rely on it.

Ans:

---

# B. Decisions I need from you

## R-01 — Tuum: what is the system of record for the contract? · **Blocking**

The largest open architectural question, recorded as OI-02.

Tuum's own published example for `POST /api/v2/offers/{offerId}/accept` returns
proportion-shaped fields on the created contract, from a request that supplies
none. Under SH-18 the Board audits the servicing platform's records — so a
Murabaha whose system of record displays a proportion is a finding on day one,
regardless of what Sanad stores.

**Recommendation.** Take SDD RSK-04's fallback as the primary design: **Sanad
owns the contract, the schedule and the profit amount; Tuum holds accounts, the
ledger and payments.** Tuum stops being the lending system and becomes the
banking substrate, which is the part of it we actually want.

This decision gates the settlement and lifecycle modules. I would rather not
design those twice.

Ans:

## R-02 — Nutrient licence scope · **Blocking**

Web SDK alone, or Web SDK with Document Engine? The two produce different
architectures, and the contract viewer, generation and signature modules are all
waiting on the answer. Related: OI-06 — no validated long-term-validation signed
document has been produced yet, so we have not proven the signature path end to
end.

Ans:

## R-03 — Board answers to OI-22, OI-23, OI-24 · **Blocking**

Three modules are blocked or excluded on these. See
[docs/open-questions.md](docs/open-questions.md); currently zero answered.

- **OI-22** — what goods an embedded Murabaha actually trades
- **OI-23** — whether a share-of-sales sweep can be determinate (SH-03)
- **OI-24** — commodity murabaha via brokers is organised tawarruq, which SDD
  §1.5 and PR-X2 exclude. I did not build it. If a Board rules differently this
  is configuration, not a code change — but I need the ruling, not an assumption.

Ans:

## R-04 — The original logo as vector · **Hygiene**

Asked three times. `BrandMark` is currently my hand-trace of a raster image. It
is close, it is not the artwork, and it should not go in front of a client as
though it were.

Ans:

---

# C. Engineering risks and hygiene

## R-12 — There is no service runtime. The contract has no handler. · **Blocking**

Worth stating plainly, because "the backend" currently means two different
things and only one of them exists.

**What exists** is the domain and its persistence: `core/` (24 modules — the
sequencing state machine, gates, pricing, obligations, evidence, legs, the
charity ledger, counterparty distinctness, the financed-invoice registry, the
decisioning engine, entitlements), `adapters/` (Tuum, Nutrient, circuit
breaker, fixture transport), and 1,596 lines of SQL across five migrations
carrying the controls as constraints. That is real backend and it is tested.

**What does not exist is anything that listens.** There is no HTTP service, no
route handler, no process to deploy. `api/openapi/origination.v1.yaml`
specifies an API that nothing implements. The only runtime today is Next.js
server actions inside the ops app, backed by an in-memory store on
`globalThis`.

That was the right order — contract first, domain first — but it means the
honest status of the partner API is "specified and tested as a contract, zero
percent implemented", and the honest status of the platform is "no deployable
service exists yet".

**Recommendation.** One Node service fronting `core/`, with the OpenAPI
document as its contract test. It is the next substantial piece of work and it
is a prerequisite for anything in Section A — you cannot stand up UAT without
something to deploy into it.

Ans:

## R-13 — `gateway/` does not exist · **Material**

CLAUDE.md §5 and §7 require `gateway/kong/` and `gateway/ibm/` holding
authentication, rate limiting, routing, mTLS, request size and CORS as
declarative configuration, one directory per implementation. Neither
directory is present.

This is not cosmetic. The reason for the split is that the client may deploy
behind IBM API Connect / DataPower, and the way that stays survivable is that
gateway concerns live in configuration rather than in code. With no
`gateway/` at all, there is nowhere for that configuration to go, and the
first person to need rate limiting will reach for the nearest middleware.

Should be created alongside R-12, even if the IBM directory starts as a
README recording what has to be reproduced.

Ans:

## R-14 — Redis is specified but absent, and it should not do all three jobs · **Material**

There is no Redis anywhere in the repository — no client, no configuration, no
connection. It appears twice in prose (CLAUDE.md §2, README) and nowhere in
code.

CLAUDE.md §2 gives it three jobs. My recommendation differs for each, so this
needs a decision rather than an implementation ticket.

| Job | Recommendation |
|---|---|
| **Freshness windows** | **Yes, Redis.** Genuine cache: how long a screening result, a bureau pull or a clearance status stays valid. Losing it costs a re-fetch. This is what Redis is for. |
| **Idempotency keys** | **PostgreSQL is the system of record; Redis at most a read-through cache.** §8 requires the response be persisted and replays return the original result. A key that can be evicted under memory pressure means a replay re-executes — in this product that is a duplicate purchase leg or a duplicate payment. Durability is the requirement, and Redis's default posture is eviction. |
| **Limit reservation** | **No Redis. Keep it in PostgreSQL.** `core.limit_reservation` and the `core.enforce_facility_capacity()` trigger already exist in migration 0004, and the domain has a `LIMIT_RESERVED` state. Coordinating reservations in Redis would create a second source of truth for remaining capacity, and the two will diverge under exactly the conditions that matter — concurrency and partial failure. A row lock in the same transaction that writes the reservation is simpler and correct. |

So: Redis earns its place for one of the three stated jobs, is a cache in front
of the second, and should be kept away from the third.

### R-14a — The Upstash endpoint specifically

A hosted endpoint (`*.upstash.io`) was proposed. Three things about it:

- **No Saudi region.** Same call as Supabase: fine for development, not lawful
  for UAT or above under NFR-05 / RC-03 / AP-09. See ADR 0001 — this is the
  identical decision, and it should be recorded the same way rather than
  arrived at again at deployment time.
- **The REST interface uses a long-lived bearer token** granting full data
  access to the whole instance. That is a coarser credential than a scoped
  connection, so it wants rotation and it must never be near a browser.
- **Every operation is an HTTPS round trip to another region.** Tolerable for
  a cache. Not tolerable on the idempotency path, where it would add a
  cross-region round trip to every state-changing request *on top of* the
  durability problem above. This is a second, independent reason to keep
  idempotency in PostgreSQL.

Using it for development is reasonable. `config.integration_credential`'s
provider list would need a cache value added — it currently allows nine
providers and none of them is a cache.

**Two constraints whichever way this goes.** Redis holding idempotency payloads
or cached counterparty data is holding customer data, so it is **in-Kingdom,
encrypted in transit and at rest, and inside the same trust boundary** — a
managed Redis in a non-Kingdom region is a residency breach on the same footing
as the database (see E-07). And it must be treated as **losable**: every path
that uses it has to be correct when it returns nothing, because that is what a
failover looks like.

Ans:

## R-15 — The OpenAPI document promises idempotency behaviour nothing implements · **Material**

Following from R-12 and R-14. `api/openapi/origination.v1.yaml` specifies:
the response is persisted against the key, a replay returns the original
result with `Idempotent-Replay: true`, and the same key with a different body
is a `409`. `IdempotencyKey` exists as a *type* in
`core/ports/core-banking.ts` and is mapped through the Tuum adapter, but there
is no store and no replay path anywhere.

The contract test asserts the header is *required*, which is true of the
document. It cannot assert the behaviour, because there is nothing to assert
it against. Worth knowing so nobody reads a green contract suite as meaning
idempotency works.

Ans:

## R-05 — Compiled `.js` files are committed · **Hygiene**

40 compiled `.js` files are tracked, produced by `"compilets.autoStart": true` in
`.vscode/settings.json`.

**Correcting something I said earlier in the session:** I initially implied this
was a compliance hole. It is not. `test/architecture/absences.test.ts` skips a
`.js` sitting beside a `.ts` of the same name, deliberately and with a comment
explaining why. So the absence scan is not evaded. It is redundant committed
build output and nothing worse.

**Recommendation.** Turn off `compilets.autoStart`, `git rm --cached` the 40
files, add them to `.gitignore`. Your editor config, so your call.

Ans:

## R-06 — Commits are being made that I did not make · **Material**

Several commits have appeared without my running `git commit` — most recently
`bb3e0ce`, which committed the icon work moments after I wrote the files, and
earlier `9565fff "Refactor code structure..."`.

I do not know what is doing this. It matters more here than on most projects: §11
makes the second-client test a **PR-description** obligation, and an automatic
commit has no PR description and no reviewer. Worth identifying before the repo
has more than one contributor.

Ans:

## R-07 — Toolchain advisories, one critical · **Material**

`npm audit`: 7 advisories, all pre-existing toolchain, none from application
dependencies.

| Severity | Package | Path |
|---|---|---|
| critical | `vitest` | via `@vitest/mocker` |
| high | `vite`, `postcss` | |
| moderate | `esbuild`, `next`, `vite-node`, `@vitest/mocker` | |

All are dev-time except the `next`→`postcss` path. Upgrading `vitest` from 2.1.9
clears most of them but may disturb the suite, so I have not done it unasked.
Worth doing as its own change before anyone runs a supply-chain review — and a
bank will run one (SDD §6.12).

Ans:

## R-08 — The "Review queue" nav entry overstates itself · **Hygiene** · ✅ **Done**

*Moved to Closed. See C-03.*

## R-09 — Front-end tests cannot run at all · **Material** · ✅ **Done**

*Moved to Closed. See C-01.*

## R-10 — Review endpoints need their own specification · **Material**

`api/openapi/origination.v1.yaml` is partner-facing only. Approve, return and
reject are deliberately absent, because a partner-authenticated API that can
approve is how a partner approves its own request.

They still need a contract. It should be a separate internal specification with
its own authentication (enterprise SSO, not client credentials) and its own
contract test. Not urgent; should not be forgotten.

Ans:

## R-11 — The brand colour is not a text colour · *(no action — record it)*

`--color-brand: #f47b20` is **2.7:1 on white**. That is below 4.5:1 and below
3:1, so it is usable for the mark, for large display type and for decorative
fills, and for nothing else. Interactive text and small UI use
`--color-brand-strong: #b05512` (5.0:1 with white).

Recording it because "use the brand colour" is the most natural instruction in
the world to give a designer, and it will fail an accessibility audit.

Ans:

---

# D. Things I deliberately did not build

Recorded so they read as decisions rather than omissions.

| | What | Why |
|---|---|---|
| **X-01** | Commodity broker integration (Elgar/Eiger, DDCAP) | Organised tawarruq. Excluded by SDD §1.5 and PR-X2. Raised as OI-24 rather than built. |
| **X-02** | Embedded lending origination | No identified goods, so no Murabaha. OI-22. |
| **X-03** | Share-of-sales repayment sweep | No determinate final payment date, which is gharar (SH-03). OI-23. I proposed a fixed backstop maturity with the sweep as voluntary acceleration — that is a Board question, not my call. |
| **X-04** | Any override, force or admin-bypass on a gate | §1.3. There is a test asserting no entitlement capable of this can be defined. |
| **X-05** | A delta chip on the dashboard KPIs | We have no history to compare against. A fabricated "+8.5%" on an operations screen is a lie with a percent sign on it. The chip carries a real fact instead. |

Ans:

---

# E. Closed

## C-01 — Front-end test harness *(was R-09)*

`vitest.config.ts` was `environment: 'node'` with `include:
['test/**/*.test.ts']`, so a `.tsx` test could not be collected. The §11
condition "reviewed in RTL **and** LTR" was enforced by nobody.

**Done.** 65 tests across `test/ui/`:

| File | Guards |
|---|---|
| `logical-properties.test.ts` | no physical-direction utility in any `.tsx`, no physical box property in any stylesheet, `MoneyProps` declares exactly four props |
| `money.test.tsx` | exact minor-unit formatting including beyond 2⁵³, three amounts always disclosed together, no `%` in either language, **a rate prop fails the build** |
| `bidirectional.test.tsx` | every component renders in both locales, none sets its own `dir`, icons are all `aria-hidden`, both calendars with the right one leading, string-catalogue parity, no untranslated Arabic |
| `aliases.test.ts` | the `@sanad/*` mapping in `vitest.config.ts` matches `tsconfig.json` |

**jsdom was deliberately not used.** These are server-rendered components;
`renderToStaticMarkup` exercises the path they actually take and asserts the
bytes a browser receives. jsdom would simulate a browser they never reach and
add a dependency to a supply-chain review for no coverage. When a genuinely
client-side component appears, add it then, for that component.

**Two things this found, worth recording:**

1. **`exclude` is inherited through `extends`.** `tsconfig.web-test.json`
   extends the root, which excludes `test/ui` so the no-DOM project does not
   try to compile JSX. The new project inherited that exclusion and compiled
   **nothing** — a green typecheck that checked none of the UI tests. Fixed
   with an explicit `"exclude": []`. Only caught by deliberately breaking a
   guard and noticing it did not fail.

2. **The rate guard is compile-time and it bites.** Adding `profitRate?:
   number` to `MoneyProps` produces `TS2578: Unused '@ts-expect-error'
   directive` and fails `npm run typecheck`. The guard survives the thing it
   guards against, which is the property that matters — a runtime test would
   have silently started passing.

Mutation-tested: `ml-4`, `sm:text-left`, `margin-left` in CSS, `text-align:
right` in CSS, `aria-hidden` removed from an icon, a component hardcoding
`dir`, an Arabic string left in English, a drifted alias, and a rate prop —
all nine caught.

## C-03 — Review queue *(was R-08)*

The nav marked it `LIVE` with `href: ''`, so it landed on the dashboard. Built
at `/[locale]/queue`, four views (needs your decision · with the servicing
platform · with the maker · decided), and the nav now points at it.

Four design decisions, each the opposite of a conventional lending queue:

- **Oldest first, with no control to reverse it.** A newest-first queue
  starves its tail, and the tail is where a counterparty has waited longest.
- **Your own work is shown and blocked, not hidden.** Hiding it would be
  tidier and worse — someone would assume the request was lost. It appears,
  marked "your own work · needs another reviewer", with no action.
- **No bulk approve.** Reviewing means looking at the trade; a checkbox column
  is a way of not looking at it. If volume makes this painful the answer is
  more reviewers, or a straight-through policy explicit about what it skips.
- **Ageing is operational only.** Display and ordering, never a gate. Gate
  timing comes from the TSA through `core/sequencing`, which `apps/` cannot
  reach.

**A real bug this surfaced.** The queue rendered newest-first despite sorting
oldest-first. Attested timestamps have one-second granularity, so a batch
arriving together ties, and the tie fell through to the repository's
descending order — silently inverting a FIFO queue. Fixed with a request-id
tie-break and a test that pins it. This will happen in production too: an
aggregator posting overnight arrives in one second.

Also added `apps/ops/src/server/session.ts`. A `'use server'` module may only
export async functions, so the principals could not live in `actions.ts` once
a screen needed to *read* who it is acting as. `canReview()` is a convenience
for the queue and explicitly **not** the control — `test/ui/review-queue.test.ts`
asserts the domain still refuses a self-approval when the screen is bypassed.

## C-02 — Partner origination API contract

`api/openapi/origination.v1.yaml` (OpenAPI 3.1) plus 27 contract tests in
`test/contract/`. Mutation-tested against nine violations, all caught.

Also widened `test/architecture/absences.test.ts` to scan `.yaml` and cover
`api/` — an OpenAPI document was previously the one place a rate field could
be added with nothing objecting, which is exactly where an integrating partner
would ask for one. It immediately caught a rate literal in my own draft.
