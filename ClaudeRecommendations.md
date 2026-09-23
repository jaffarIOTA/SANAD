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
- **On-premises makes RPO 0 achievable.** With two in-Kingdom datacentres,
  synchronous replication for those two schemas over a metro link is ordinary
  engineering. The same guarantee across cloud regions is expensive and slow,
  so this constraint got considerably cheaper when the cluster turned out to be
  on-premises (E-15).
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

## E-14 — Cluster-wide rate limiting is a fourth, legitimate Redis job · **Material**

Noticed while writing the gateway configuration, and it amends R-14.

Kong's rate-limiting plugin with `policy: local` counts per data-plane node.
With three nodes behind a load balancer, a caller limited to 100 requests a
minute actually gets 300. Enforcing one shared limit needs shared counters,
and for Kong that means Redis.

This is a genuine cache workload and it is the cleanest of the four: the
counters are ephemeral by nature, losing them fails *open* toward the
configured limit rather than corrupting anything, and no customer data is
involved. Unlike idempotency, eviction here is survivable.

It also has to be in-Kingdom and inside the trust boundary like everything
else — and it is a second Redis *use*, not necessarily a second Redis.

Ans:

## E-09 — Azure has no in-Kingdom region until November 2026 · **Blocking**

Hosting the gateway — or anything else — in "our Azure" runs into the same
wall as Supabase and Upstash, and the date matters.

Microsoft's **Saudi Arabia East** region (Eastern Province, three availability
zones) is announced for **November 2026**. As of today it is not generally
available. Every other Azure region, including UAE North and UAE Central, is
outside the Kingdom.

So an Azure deployment today is lawful for `development` and `sandbox` and for
nothing above them. UAE North is *not* a substitute: NFR-05 / RC-03 / AP-09
say in-Kingdom, and the Gulf is not the Kingdom.

**Recommendation.** Two viable paths, and they should be chosen deliberately
rather than drifted into:

1. **Wait for Saudi Arabia East** and sequence UAT to land after it. If UAT is
   scheduled before November this does not work.
2. **Use an in-Kingdom provider now** — the local hyperscaler partnerships or
   a licensed in-Kingdom datacentre — and treat Azure as the later target.

Either way the decision belongs in ADR 0001 as an amendment, because it sets
the earliest possible UAT date. This is the first item in this register that
constrains a *schedule* rather than a design.

Ans:

## E-10 — Do we run Kong in production at all? · ✅ **Answered**

**No.** The bank runs **IBM DataPower on Red Hat OpenShift Container
Platform**, on the bank's own instance. We do not host, operate or pay for the
production gateway; we supply an API definition and the policy obligations in
`gateway/ibm/README.md`.

Consequences, which settle three other items:

- **E-11 (Kong licensing)** — moot for production. Kong OSS in development and
  sandbox only, effectively free.
- **E-12 (Azure Kong cost)** — moot. There is no production Kong to host.
- **E-13 (Konnect)** — probably unnecessary entirely. It was proposed as a way
  to avoid self-hosting; with no production Kong, a local containerised Kong
  covers the lower environments at no cost and with no control plane abroad.

See E-15 for the one question this opens rather than closes.

## E-11, E-12, E-13 — Kong licensing, hosting cost, Konnect · ✅ **Closed — Kong removed**

All three analysed a gateway the product no longer carries. `gateway/kong/`
has been deleted: IBM API Connect is the integration layer for every flow, and
a configuration nothing applies rots while implying a tested capability that is
not tested.

The analyses are retained in git history if a future institution brings a
different gateway.

**What did not go with it** is the independence — no service reads a
gateway-injected header, every service re-validates identity and tenant
itself, contract tests run against the service directly. That is not Kong
nostalgia. Sanad deploys to each buying institution's own cluster under its own
policy (E-23), so the second institution may not run API Connect, and the
independence is what makes that a configuration exercise rather than a fork.
It is also what keeps us off an enterprise licence: the gateway is not our
identity source, so no OIDC policy is load-bearing.

Asserted by `test/architecture/gateway.test.ts`, which now reads the API
Connect artefacts and additionally checks that `gateway/kong/` is absent.

## E-15 — Is the OpenShift cluster on-premises, or ARO? · ✅ **Answered**

**On-premises.** The bank's own Red Hat OpenShift, in the Kingdom.

This is the best available answer and it settles more than it appears to:

- **E-09 stops blocking the platform.** Our services deploy to the bank's
  cluster beside DataPower, in the Kingdom, from day one. The Azure region
  timing no longer gates UAT. Azure may still be useful for our own build and
  development infrastructure, where no real data exists and residency does not
  bite — that is now a convenience decision, not a compliance one.
- **Compute residency is satisfied by construction** rather than by
  configuration, which is a much stronger position.
- **DR becomes a second datacentre, not a second region.** That materially
  helps E-02: synchronous replication for `evidence` and `audit` over a metro
  link between two in-Kingdom datacentres is ordinary engineering, where the
  same RPO-0 guarantee across cloud regions is expensive and slow. Saudi banks
  typically already run primary and DR sites — ask which two, and what the
  latency between them is.

It also sharpens three questions that were previously vague. See E-17, E-18
and E-19.

## E-16 — DataPower can rewrite a body, and that is a new risk · **Material**

Kong needed a one-line prohibition. DataPower needs a section, because the
thing being prohibited is what DataPower is *for*.

GatewayScript, XSLT and JSON/XML mediation are its core competency and the
first tool an experienced DataPower team reaches for. Three specific failure
modes follow, all of them well-intentioned:

1. **A gateway that normalises JSON silently disables SH-01.** Our schemas are
   closed, and refusing an unknown property is how a rate-shaped field cannot
   be posted. A policy that strips unknown fields before forwarding means the
   service never sees the field it exists to reject, and the request succeeds.
2. **A gateway that rewrites an error strips the control code.** DataPower's
   default is to replace an upstream fault with its own format. A compliance
   rejection that loses `SH-10` becomes a generic decline, which §6 and §8 both
   forbid.
3. **A gateway that transforms a body can change an amount.**

`gateway/ibm/README.md` states all three as prohibitions. The acceptance test
is the defence: the contract suite must pass through DataPower unchanged, and
two of its assertions — the unknown-property refusal and the problem-detail
control code — are precisely the ones a helpful policy would break.

**Get this in front of their DataPower team early**, before an assembly is
written. It is much easier to not add a transform than to remove one.

## E-17 — What is the database platform on the bank's cluster? · **Blocking**

The largest remaining platform risk, and it is now askable in concrete terms.

ADR 0001 decided self-hosted PostgreSQL. On the bank's OpenShift that resolves
two very different ways:

1. **PostgreSQL on-cluster**, via an operator, managed by us. What ADR 0001
   assumes, and what every migration in `supabase/migrations/` is written for.
2. **The bank's existing database estate**, managed by their DBAs. In a Saudi
   bank that is frequently **Oracle or Db2**, and for an IBM shop running
   DataPower, Db2 is a live possibility.

Option 2 is not a configuration change. Our schema is PostgreSQL-specific in
places that are load-bearing rather than incidental:

- **Row-level security** on every table, with a tenant-scoping policy. Oracle's
  analogue is VPD; Db2's is LBAC. Both exist, neither is a translation.
- **Deferred constraint triggers** carrying SH-02 — an executed total never
  increases. The deferral is what lets a multi-row reschedule be checked as one
  transaction.
- **Immutability triggers** on executed records, and append-only evidence and
  audit tables with no `UPDATE` grant.
- `gen_random_uuid()`, which is trivial to replace and mentioned only so the
  list is complete.

**Ask now, not at UAT.** If the answer is Oracle or Db2, the schema work is
substantial and the compliance constraints have to be re-expressed in a
different dialect — which means re-proving them, not just re-writing them.

Ans:

## E-18 — Egress to SaaS goes through the bank's proxy · **Material**

An on-premises cluster does not have open outbound internet. Calls to Tuum, to
the document platform, to a timestamping authority and to any registry go
through a forward proxy with an allowlist, and quite possibly through TLS
interception.

Two consequences, recorded now because **no live HTTP client exists yet** — the
adapters are ports with fixture implementations, so this is a requirement on
the transport we write rather than a defect in one we have:

1. **Node's `fetch` does not honour `HTTPS_PROXY`.** Unlike curl or most
   language runtimes, undici ignores the conventional environment variables
   unless given an explicit `ProxyAgent` dispatcher. A transport written the
   obvious way will work on a developer's laptop and fail in the bank's
   cluster, which is the worst time to find out.
2. **If the bank terminates TLS for inspection**, the client must trust their
   internal CA, and certificate pinning becomes impossible. Worth knowing
   before anyone proposes pinning as a control.

Also ask for the **allowlist process and its lead time**. In most banks it is
measured in weeks, and it applies per environment — so it belongs on the
critical path for UAT, not in the week before.

Ans:

## E-19 — If compute must be in-Kingdom, why is the core banking platform not? · **Blocking**

The sharpest question the on-premises answer raises, and it needs asking of the
client rather than answering by us.

The reason the cluster is on-premises and in-Kingdom is NFR-05 / RC-03 / AP-09:
customer, transaction and document data is stored and processed in the Kingdom,
"including for logs, backups, analytics and third-party processors."

**Tuum is SaaS.** If it is the system of record for accounts, balances and
payments, then customer and transaction data is processed outside the Kingdom
by a third-party processor — which is the thing the on-premises decision exists
to prevent. The same question applies to the document platform, and more
sharply, because executed contracts are the statutory-retention artefacts.

Three possible answers, and the client has to pick one:

1. **The vendor deploys in-Kingdom** — self-managed or in a local region.
   Changes the commercial conversation and possibly the vendor.
2. **A documented exemption exists** for that class of processing. Then it
   should be written down, with its scope, rather than assumed.
3. **Minimise what crosses.** Sanad holds the contract, the schedule, the
   profit amount and the evidence; the external platform holds only what it
   must.

Option 3 is **the same recommendation already made in R-01 for an entirely
different reason** — that a servicing platform displaying a proportion against
a Murabaha is a Shariah audit finding on day one. Two independent arguments
converging on one design is usually a sign the design is right.

Ans:

## E-20 — API Connect · ✅ **Decided**

**IBM API Connect**, as a single platform for three integration flows: front
end to back end, partner integration, and bank integration.

**My earlier advice was scoped too narrowly and I am withdrawing it.** I
assessed API Connect against the partner API alone and concluded DataPower was
sufficient — which it is, for that one flow. Judged against three flows on one
platform, one vendor, one skillset and an estate the bank already runs, the
decision is sound and the earlier comparison was answering a smaller question.

Two flows are a good fit and one is not an API integration at all. See E-21.
The deployment location is now more important than it was. See E-22.

### Where it genuinely helps

- **Partner integration** is what API Connect is for. Products, Plans and
  subscriptions map onto partner onboarding, and the Developer Portal is worth
  having once there are more than two partners.
- **Bank and vendor integration** — outbound to the core banking platform, the
  document platform, the e-invoicing authority, the identity provider. A single
  governed egress point is **better** than each adapter dialling out
  independently: it is one place to hold the allowlist (E-18), one place that
  logs what left, and one place to enforce what must not (E-19).

### One caution that grows with the scope

E-16 gets larger, not smaller. An assembly is where DataPower transforms, and
API Connect makes assemblies the natural unit of work. If **all** integration
now flows through assemblies, the temptation to transform a body is present on
every path rather than one. The SH-01 control depends on bodies arriving
exactly as sent, so `gateway/ibm/README.md`'s prohibitions now apply to more
surface. Raise them with the DataPower team before the first assembly, not
after the tenth.

## E-21 — "Front end to back end" is not an API integration here · **Material**

Worth separating, because it is the one of the three flows where the platform
may not apply — and if it is forced to, it breaks something.

Our front end is Next.js with **server components and server actions**. The
browser does not call the origination API. It calls the Next.js server, which
renders HTML and handles form posts; the Next.js server then calls the service.
So "front end to back end" is two hops, and neither is a partner-style API
call:

1. **Browser → Next.js server.** These are HTML requests and server-action
   posts. A server action is an opaque POST carrying a `Next-Action` header and
   React's own streaming encoding. An API gateway cannot manage it as an API —
   there is no schema to validate, no Product to attach — and **any body
   transformation breaks the protocol outright**. This hop wants a load
   balancer and TLS, not API management.

2. **Next.js server → origination service.** East-west, inside the cluster,
   both sides ours, inside one trust boundary. Routing it through API Connect
   adds a hop to every page render and buys little: the service already
   authenticates, and there is no third party to govern.

**This is not an objection to API Connect.** It is a scoping point: flows 2 and
3 are a good fit, flow 1 mostly is not. Putting the browser-facing hop behind
API Connect will produce effort and latency for no control.

**Unless the intent is a different front end.** If the plan is to move to a
browser-side application calling the API directly, then flow 1 becomes a real
API integration and API Connect fits it properly. That is a genuine
architectural choice with consequences for §6 — server-rendered today means the
front end never infers a gate result, and transaction state always originates
from the server. Worth deciding deliberately rather than by gateway placement.

Ans:

## E-22 — Where does API Connect run? · **Blocking**

More important now than when it was one flow, because API Connect is becoming
the main data path rather than a side channel.

**IBM Cloud has no Saudi region**; its Middle East data centres are in the UAE.
So:

- **Deployed on the bank's on-premises OpenShift** — the right answer. Runtime
  and control plane both in the Kingdom, beside the services and DataPower.
  API Connect is supported on OpenShift and this is the common pattern in the
  Gulf.
- **Consumed as a managed service on IBM Cloud** — the control plane, the
  analytics and the configuration sit outside the Kingdom, and now so does the
  governance of *all three* integration flows. This is the same analysis as
  E-13, which we rejected for Kong Konnect, with more traffic behind it.

Buying the entitlement *through* IBM Cloud as a commercial channel is fine and
says nothing about where it runs. **Confirm the deployment target is the
on-premises cluster** before the purchase is structured, because the two are
priced and licensed differently and it is awkward to change afterwards.

Ans:

## E-23 — Sanad is a product with two deployment targets · *(record it — it validates a lot)*

**Sanad runs on our cloud; once sold, it is deployed to the bank's own
on-premises OpenShift, per that bank's policy.**

This is the most clarifying thing said so far, and it should be written into
ADR 0001, because several decisions that read as caution now read as
requirements:

- **The second-client test stops being hypothetical.** §7 asks of every change
  "would the next client want this exact behaviour?" There is now a concrete
  next client, and a third, each with their own cluster.
- **Tenant-scoped, effective-dated configuration (§1.7) is the product.** Two
  Boards ruling differently is not an edge case — it is the delivery model.
- **The gateway abstraction (§5) is necessary, not theoretical.** Each bank
  brings its own gateway. `gateway/` having one directory per implementation is
  how a second bank is onboarded rather than forked.
- **No client name in `core/`**, which CI already greps for, is load-bearing
  rather than tidy.
- **`config.deployment_profile` was designed for exactly this** — one row per
  deployment, carrying `data_region` and `production_data_permitted`, with a
  constraint refusing production data outside the Kingdom behind a
  platform-managed key. It needs no change. Worth noting that it already fits,
  because it means residency is a per-deployment property rather than a global
  assumption.

### The new requirement this creates

**Our cloud deployment must acquire no dependency that cannot be reproduced
on-premises.** This is the Supabase trap again, one level up and with more at
stake: anything convenient in our cloud — a managed cache, a managed object
store, a cloud key vault, a managed Postgres extension — becomes a porting
problem at the moment of sale, which is the worst possible moment to discover
it.

The discipline that keeps this honest is the one ADR 0001 already established:
every external capability sits behind a port in `core/ports/`, with the cloud
convenience as one adapter and an on-premises equivalent as another. Where no
on-premises equivalent exists, that is a decision to take deliberately and
record, not a detail to leave to the port's implementer.

### One question

**Does the cloud instance ever hold a live client's real data** — a pilot, a
proof of value, a trial with real invoices? If it does, everything in Section A
applies to it in full, including residency. If it is only demonstration and
development on synthetic data, none of it bites and the cloud choice is free.

The answer is likely "not yet, but a pilot will", which means it should be
decided before the pilot is sold rather than during it.

Ans:

## E-24 — Migrating a hash chain · **Partly settled by test**

Tested rather than assumed: `test/compliance/chain-migration.test.ts`, 11
tests that do to a chain what a migration does.

### Settled — the chain survives a move

**The chain binds content, not storage identity.** `prevLegHash` references
the predecessor's `contentHash`, and nothing else. So a chain verifies after
serialisation, after every `legId` is reassigned by the target database, and
after row order is lost — and in that last case the correct order is
*recoverable from the hashes alone*, without trusting a sequence number or the
storage layer.

It also still refuses what it refused before: content altered in transit, a
leg dropped by a partial load, and a leg reordered without relinking are each
caught with `HASH_CHAIN_BROKEN`.

That is the property E-24 worried about, and it holds by design.

### Found while testing — a leg cannot be exported through plain JSON

`JSON.stringify` throws on a leg: `TsaInstant.epochSeconds` is a `bigint`,
chosen so an attested time is never approximated.

The throw is the *good* case. The bad case is an exporter that "fixes" it with
`Number(...)` and silently loses precision on a timestamp with contractual
effect. Two tests now pin this — one asserting the naive path throws, one
asserting an instant beyond 2⁵³ survives a proper encoding exactly — so nobody
discovers it by reaching for the lossy fix under deadline.

**Any migration tooling must encode bigint explicitly.**

### Still open — the part a unit test cannot reach

**The attestation tokens live outside the database.** The domain carries
`tsaTokenDigest`; the RFC 3161 token itself is stored alongside, in object
storage under write-once retention.

A database migration that leaves the object store behind produces a chain that
verifies *internally* and cannot be proven to a third party. The Board's
verification needs the tokens, not the digests. This is the most likely thing
to be forgotten in a move, because the database migration will look complete
and the tests will pass.

**Recommendation.** The migration procedure moves the object store first and
verifies token retrieval for every leg before the database cutover, and the
acceptance test for a move is a gate replay over the migrated evidence — the
same test as for DR (E-02). Both are available only because gate evaluation is
a pure function of transaction and evidence set (§1.3).

Ans:

## E-27 — Tuum through API Connect: an egress pipe, not a published catalogue · **Material**

Asked: bring all Tuum APIs into API Connect. Built: a controlled egress,
scoped to what we call. The difference is worth recording because the first
reading is the intuitive one and it conflicts with two rules.

### Where the value genuinely is

On the bank's on-premises cluster there is no open outbound internet. Egress
goes through a forward proxy with an allowlist (E-18). Making API Connect that
point gives one place holding the allowlist, one place recording what left,
one place to rate-limit and break the circuit. That is real and worth having.

### Why "all Tuum APIs" is the wrong scope

**We depend on seven capabilities** — resolve a party, resolve an account,
book an obligation, instruct a settlement, post a charity liability, fetch
exposure, receive lifecycle events. Tuum has dozens of endpoints across
person, account, payment, card and lending APIs.

Publishing all of them means supporting all of them. Every published operation
is one somebody may call, and one somebody may call is one we own — including
the lending endpoints, whose accepted-offer response carries the
proportion-shaped fields that make OI-02 a Board finding.

### Why a façade would be worse than a pipe

The tempting shape is a façade: expose *our* capability names, map them onto
Tuum's. That puts domain mapping in the gateway, which is the wrong layer
(§7), and it is precisely the transformation that must not happen on a
DataPower assembly (E-16).

So it is a **pass-through**. `adapters/tuum/` stays the only thing that
understands Tuum's shape, which is what keeps a vendor DTO from crossing out
of the adapter layer (§1.1, §7).

### One thing the test caught

The first draft gave `tuum-base-url` the sandbox host as a default. A default
is an environment's host committed to git, and the failure is the bad kind:
publish to a production catalog without overriding it and production transacts
against a sandbox while every test passes. There is now no default, so a
missing value fails loudly at publish.

### Deliberately deferred

**Credential injection at the gateway.** The adapter authenticates today. Moving
that to the gateway would mean services never hold a Tuum credential, which is
attractive — and it changes who appears in Tuum's audit trail, which under
SH-18 the Board reads. A separate decision, not something to slip in with a
routing change.

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

## R-12 — There is no service runtime · **Blocking** · ✅ **Done**

*Moved to Closed. See C-04.*

## R-13 — `gateway/` does not exist · **Material** · ✅ **Done**

*Moved to Closed. See C-05.*

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

## R-05 — Compiled `.js` files are committed · ✅ **Done**

*Moved to Closed. See C-07.*

## R-06 — Commits are being made that I did not make · **Material**

Several commits have appeared without my running `git commit` — most recently
`bb3e0ce`, which committed the icon work moments after I wrote the files, and
earlier `9565fff "Refactor code structure..."`.

I do not know what is doing this. It matters more here than on most projects: §11
makes the second-client test a **PR-description** obligation, and an automatic
commit has no PR description and no reviewer. Worth identifying before the repo
has more than one contributor.

Ans:

## R-07 — Toolchain advisories · **Mostly done — 2 remain**

Was 7 advisories including one critical. Now **2**, both the same root cause.

**Fixed** by upgrading vitest 2.1.9 → 5.0.1 and vite 5.4 → 8.3: the critical
`vitest`/`@vitest/mocker` advisory, the high on `vite`, and the moderates on
`esbuild` and `vite-node`. All 390 tests pass on the new major with one config
change — vitest 5 transforms with oxc rather than esbuild, so the
`esbuild: { jsx }` option was silently ignored and has been removed.

**Remaining**, and deliberately not fixed:

| Severity | Package | Path | Fix |
|---|---|---|---|
| high | `postcss` | bundled inside `next` | Next 16 (major) |
| moderate | `next` | the same `postcss` | Next 16 (major) |

Both are the same advisory: *PostCSS XSS via unescaped `</style>` in CSS
stringify output*. Two reasons to leave it for now rather than take a major
framework upgrade as part of a hygiene batch:

1. **It is a build-time path we do not expose.** PostCSS runs during our build,
   over our own stylesheets. Exploiting this needs attacker-controlled CSS
   entering the build, which would already be a supply-chain compromise of a
   different order. The practical risk here is close to nil.
2. **Next 15 → 16 is a major** touching both applications and the App Router
   surface. It deserves its own change with its own verification, not a line
   in a batch about `.gitignore`.

**It will still show up on a bank's supply-chain review** (SDD §6.12) as a
*high*, and "we assessed it as not exploitable" is an answer that needs to be
written down before it is asked for. This paragraph is that answer; the
upgrade should be scheduled regardless.

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

## C-06 — Secrets pre-commit hook

The guard written earlier caught a live Upstash token — one commit **after** it
had been committed and pushed. Same patterns, now wired to `pre-commit` so it
blocks instead of reporting.

- `scripts/secret-patterns.mjs` — one source of patterns, so the hook and the
  architecture test cannot drift.
- `scripts/scan-staged.mjs` — scans the **index**, not the working tree,
  because the file on disk may already have been cleaned while the staged
  content still carries the value.
- `.githooks/pre-commit` — versioned, because a hook only one person has is not
  a control. Enabled with `git config core.hooksPath .githooks`.

Kept under a second: the staged scan plus one test file, not the suite. A hook
that takes ten seconds is a hook that gets bypassed.

Verified by attempting four real commits, all refused: a token pasted into
`.env.example`, a staged `.env.local`, a `NEXT_PUBLIC_` secret, and a PEM
block. A clean commit still passes. Ten further cases are asserted in
`test/architecture/secrets.test.ts` by invoking the scanner the hook calls —
behaviour, not source, so the test cannot pass while the hook is broken.

**This does not undo the exposed token.** Rotation is still the fix.

## C-07 — Compiled JavaScript untracked *(was R-05)*

48 tracked `.js` files, every one shadowing a `.ts` of the same name, none
hand-written. Untracked with `git rm --cached` and ignored.

The ignore is scoped to the four trees the output appears in — `core/`,
`adapters/`, `config/`, `test/` — rather than a blanket `*.js`, so genuinely
hand-written JavaScript elsewhere stays tracked. Config files are `.mjs` and
unaffected.

`.vscode/settings.json` still has `compilets.autoStart`, and I have left it
alone: it is your editor. The files still appear on disk and git now ignores
them, which is a fine outcome either way.

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

## C-04 — Origination service *(was R-12)*

`services/origination/` — `node:http`, no framework, four operations, 35
contract tests driven over a real socket.

The load-bearing piece is `contract.ts`: the OpenAPI document is compiled into
runtime validators, so `additionalProperties: false` stopped being a claim in
a document and became a behaviour. Hand-written validation would have drifted
from the spec within a release, which is the failure §8 exists to prevent.
`ajv` is the one new dependency and that is its justification.

**A cross-partner data leak, caught by its own test.** Idempotency was scoped
by tenant alone. Several partners share a tenant, so partner B presenting
partner A's key received A's stored response — carrying A's counterparty,
trade and amounts. Now scoped `(tenant, partner, key)`.

**A domain gap the contract exposed.** `withdraw()` did not accept
`AWAITING_SERVICING_RESPONSE`, so a partner could not withdraw while the
servicing platform was still deliberating. Widened; the decided states remain
absent from the signature, so withdrawing an approved request does not
typecheck.

Still outstanding from this slice: the service's repository is separate from
the ops workbench store, so a request raised over the API does not appear in
the review queue. Both collapse onto the database.

## C-05 — `gateway/` *(was R-13)*

`gateway/kong/kong.yaml` (DB-less, decK-applied), `gateway/kong/README.md`,
`gateway/ibm/README.md`, and 16 tests in `test/architecture/gateway.test.ts`.

Every plugin is open-source. There is deliberately **no authentication
plugin**: the service authenticates every request itself, so the gateway is
not an identity source — which is both what keeps it swappable and what keeps
us off an enterprise licence.

`retries: 0`, asserted by test. A gateway retry reissues a request **without a
fresh idempotency key**, which is the one path by which this platform can
execute an instruction twice.

Mutation-tested: a gateway retry, an OIDC plugin, a body-rewriting plugin, a
plaintext listener, a browser origin, and a service reading a consumer header
— all six caught.

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
