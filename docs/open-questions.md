# Open questions for the Shariah Supervisory Boards

**Extends the Verification Register at SDD Section 9.** Numbering continues from OI-21.

| | |
|---|---|
| Status | Open — raised 22 September 2026 |
| Raised by | IOTA Solution Architecture, during design of the origination channels |
| Addressed to | Each institution's Shariah Supervisory Board, through the Shariah governance function |
| Also relevant to | Credit Risk (OI-23), Compliance (OI-24) |

## Why these three, and why now

Each Board is asked to rule on its own institution's deployment. Where the two Boards
differ, the difference becomes a configuration key rather than a code change (SDD §3.11),
so a divergent answer is a workable outcome — it is an *unanswered* question that is
expensive.

All three arise from the same request: extend origination beyond the counterparty's own
portal into partner systems and embedded aggregator platforms. Two are genuinely open.
One (OI-24) already has a position in the specification, and is recorded here because it
has been proposed again and the answer should be explicit rather than inferred.

**None of these blocks Phase 1 as specified.** Distributor Finance under Murabaha with a
single anchor is unaffected. They block the *extensions* being considered on top of it.

---

## OI-22 — What goods does an embedded Murabaha trade?

**Severity: Critical** for the embedded channel. No impact on Phase 1 as specified.
**Owner:** Shariah Board, with the business.

### The situation

The proposal is that aggregator platforms — the large marketplaces and delivery
platforms — nominate merchants in their networks for financing.

A Murabaha requires the institution to buy goods, take title, bear ownership risk and
sell them on. In Distributor Finance that is straightforward: the anchor sells real
cement, the institution buys it, holds it, and sells it to the distributor.

In embedded finance it is not obvious what is bought and sold. A restaurant on a delivery
platform typically wants working capital, not goods.

### The question

**In the embedded channel, who is the seller and what are the goods?**

Three answers are possible, and they have very different consequences:

| | Structure | Consequence |
|---|---|---|
| **(a)** The merchant is buying real supplies — ingredients, packaging, stock, equipment — from an identifiable supplier, and we finance that purchase | Genuine Murabaha. The aggregator's role is nomination and collection only; it is not a party to the trade | **Buildable now.** Configuration on the existing engine |
| **(b)** The aggregator itself sells goods to the merchant — a marketplace selling inventory to its own seller | Genuine Murabaha, and the aggregator is simply an **anchor** | **Buildable now**, and the best fit: it is Distributor Finance with a different anchor. No new structure at all |
| **(c)** The merchant wants cash, with no underlying purchase | **Not a Murabaha.** There is no seller and no goods | Either organised tawarruq (see OI-24) or a different structure — Musharaka or Mudaraba, which the SDD places in Phase 3 — or nothing |

### What we need from the Board

1. Does the Board accept **(a)** and **(b)** as ordinary Murabaha, requiring no new ruling
   beyond the existing Distributor Finance approval?
2. Under **(a)**, does it matter whether the supplier is on the aggregator's platform or
   outside it?
3. Under **(b)**, does the aggregator acting as both seller and collection agent raise any
   concern the anchor model does not already address?

### What has been built in the meantime

The channel exists in the domain model, with two controls the Board may wish to note:

- an aggregator may **introduce** a merchant but cannot consent on its behalf — a mandate
  from the merchant itself is required, and its absence is refused;
- the channel requires four-eyes review, because the party asking for credit is not the
  party who will owe it.

The channel is shown on the operations dashboard as **blocked**, with this question named
as the reason. It cannot be used until the Board answers.

---

## OI-23 — Can a share-of-sales collection be determinate?

**Severity: High** for the embedded channel. **Owner:** Shariah Board, with Credit Risk.
**Related:** OI-12 (early settlement relief), SH-02, SH-03, SH-04.

### The situation

The proposal is that repayment is collected through the aggregator, in one of several
shapes configured per programme:

- a **percentage of each day's settlement** to the merchant;
- a **fixed amount each day**;
- a single deduction **weekly, fortnightly or monthly**.

### What is not in question

The total does not change. It is fixed at execution as cost plus profit and no collection
mechanism alters it (SH-02). Collecting faster or slower changes when the institution is
paid, not what it is owed.

### What is in question

SH-03 requires that payment dates are **fully determinate** before a contract can reach an
executable state. A fixed daily amount or a periodic sweep is determinate. **A percentage
of sales is not**: if trade is slow the final payment date moves, and if trade stops it
does not arrive at all.

There is a second question behind it. Does a collection amount that varies with the
merchant's turnover introduce contingency of the kind SH-04 excludes — or is it simply a
payment mechanism, with the contingency sitting outside the contract?

### The resolution we would propose, for the Board to accept or reject

**A fixed total, a fixed backstop maturity, and the sweep as acceleration.**

The merchant owes a determinate amount by a determinate date. The percentage sweep
collects against that obligation and clears it sooner when trade allows. If trade is slow,
the backstop date still governs and the ordinary arrears process applies.

This keeps determinacy while preserving the commercial behaviour the aggregator wants. It
is a common structure, but we would rather have it ruled on than assume it.

### Consequent questions, if the Board accepts the structure

1. Where the sweep clears the obligation **early**, does the Board's *ibra'* position
   (OI-12) apply automatically, on request, or not at all?
2. Is there a **ceiling** on the sweep percentage — a rate of collection that would leave
   the merchant unable to trade is a hardship question before it is a credit one (SH-14).
3. Who holds the **collection mandate** — the merchant instructing the aggregator, or the
   aggregator acting under its own agreement? This interacts with OI-22.

### What has been built in the meantime

Nothing. Collection scheduling is shown on the operations dashboard as blocked, with the
determinacy question named. We did not want to build a mechanism and then discover it had
to be unbuilt.

---

## OI-24 — Commodity murabaha, and the position on organised tawarruq

**Severity: Critical** if the answer changes the specification. **Owner:** Shariah Board.
**Relates to:** SDD §1.5, PR-X2, OIC International Islamic Fiqh Academy resolution.

### The situation

Integration with commodity trading platforms has been proposed, so that metals can be
bought and sold to generate a deferred-payment obligation.

### The specification's existing position

This is **organised tawarruq**, and it is already excluded:

> "Tawarruq and any cash-generating structure — Contested. Organised tawarruq was ruled
> impermissible by the OIC International Islamic Fiqh Academy. **Excluded from Phase 1
> entirely**; admissible later only on an explicit ruling of the Board, with enforced
> conditions and a volume cap." — SDD §1.5, and PR-X2 in the product scope.

We are not asking the Board to revisit this unprompted. We are recording that it has been
proposed, so the answer is explicit on the file rather than inferred from a document.

### Two cases, which should not be conflated

**For Distributor Finance, a commodity platform serves no purpose.** The goods are the
anchor's real goods. Inserting a synthetic metals trade would replace a real trade with a
fictional one, which is precisely the move the product exists to avoid — the SDD's own
framing is that Wasl "replaces it with a real trade" and that a restyled equivalent is
*hiyal* (§3.4). We would advise against it regardless of any ruling.

**For merchant working capital, it is the standard industry answer**, and that is exactly
why it needs the Board rather than an architect. If OI-22 resolves to case (c) — the
merchant wants cash and there is no underlying purchase — then commodity murabaha is the
mechanism the market would reach for, and this question becomes the one that decides
whether the product exists at all.

### What we need from the Board

1. Does the Board permit **any** commodity murabaha for this institution, and if so under
   what conditions?
2. Does it distinguish between a customer who genuinely takes the commodity and one who
   sells it immediately for cash?
3. If permitted, what **volume cap** applies, and against what denominator?
4. Are there conditions the Board would require that a **system** must enforce rather than
   a policy describe? The specification anticipates this — "enforced conditions and a
   volume cap" — so any ruling will need translating into controls the platform applies,
   not guidance an operator follows.

### What has been built in the meantime

Nothing, and deliberately so. The capability appears on the operations dashboard marked
**excluded this phase**, citing §1.5, so that the position is visible on the operating
surface rather than only in a document. If the Board rules it admissible, the conditions
and the cap would be implemented as structural controls before the integration is built.

---

## What happens to the answers

Per SDD §3.11.4, each answer becomes one of two things:

- where both Boards agree, the agreed position becomes the **platform default**;
- where they differ, the point becomes a **named configuration key**, and the adversarial
  compliance suite is parameterised against it so that neither Board's ruling is encoded
  into the tests.

Answers should be recorded in the divergence map alongside the Phase 0 question set.
