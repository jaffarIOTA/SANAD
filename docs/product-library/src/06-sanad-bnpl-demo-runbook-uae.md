---
title: BNPL Demonstration Runbook
subtitle: How to present SANAD's buy-now-pay-later journey to a UAE institution, what to say about the Emirates, and every command and click, rehearsed.
edition: United Arab Emirates
classification: Internal — IOTA pre-sales only
version: 1.0
date: 2 November 2026
---

## How to use this runbook

:::internal Handling
This runbook is for the IOTA presenter and the person driving the screens. Do not send it, or extracts of it, to the client. It names development credentials by variable, unbuilt work and open legal questions. Client-facing material is the Product Guide (UAE) and the API Catalogue.
:::

The demonstration is on **Thursday 5 November 2026** for a UAE institution. The client is not named in this document.

Read it in this order:

1. **The position** below, so that nothing said in the room has to be taken back later.
2. **Before the day**, then **Setting up**: rehearse the whole script once on the machine you will present from.
3. **The demonstration script**: six acts, about 30 minutes, with what to show, what to say and what you should see.
4. **If something goes wrong** and **Questions and answers**: keep them open beside you.

Every command and every screen in this runbook was run on 2 November 2026 against the code at the top of the PR stack (`journey-b1-intake-contact-channels`). The screenshots are from that run.

## The position, in one page

:::key Two countries, two regulators
Saudi Arabia and the United Arab Emirates are separate jurisdictions. **SAMA** (the Saudi Central Bank) regulates BNPL in Saudi Arabia and has no authority in the UAE. The **CBUAE** (the Central Bank of the UAE) regulates BNPL in the UAE, as short-term credit facilities, and has no authority in Saudi Arabia. No SAMA rule applies to the client, and nothing on screen on Thursday is a UAE rule.
:::

:::key What we are showing
SANAD's **Saudi** BNPL product, configured for a Saudi demonstration bank and governed by SAMA's rules, used to show what the two countries' products would share: the engine and the journey. A merchant onboarded under four eyes, a checkout opened by the merchant's API call, the shopper's disclosure in Arabic and English, acceptance, booking, the payment to the merchant, the credit-bureau report, and the refusals that protect the shopper. Every currency, limit, age rule, rail and citation on screen is Saudi.
:::

:::warn What we are not showing
**A UAE BNPL product.** SANAD has none yet (ADR 0005: the BNPL module as built is Saudi, riyal-only). A UAE product is built to the CBUAE's rules from the CBUAE's text. It is not the Saudi product with the currency changed, and it is not configuration alone: the module's code holds the Saudi rules today (riyal-only, SAMA's SAR 10,000 ceiling and 12-instalment maximum, the Hijri age rule). Say so at the start, plainly, before the client notices it.
:::

**What to say at the start:**

> "What you will see is our Saudi BNPL product, governed by SAMA, Saudi Arabia's regulator, because that is the one complete today. SAMA's rules do not apply to you; the CBUAE's do. We are showing it for what a UAE product would share: the engine, the journey and the controls. The BNPL rules themselves are written for Saudi Arabia today: riyals only, SAMA's limits, a Hijri age rule. For the Emirates we build a UAE rule set from the CBUAE's text: dirhams, the CBUAE's limits each with its article number, a Gregorian age rule, UAE Pass and AECB. That is development work, not a setting we switch."

**Saudi product shown, UAE product to build** (the follow-up work, not the demonstration). The two columns are different regimes; nothing carries across from the left to the right.

| Area | Saudi Arabia: SAMA (shown on Thursday) | UAE: CBUAE (to build) |
|---|---|---|
| Regulator and rule | SAMA Rules for Regulating BNPL Companies, Nov 2023 | CBUAE Finance Companies Regulation as amended in 2023 to cover short-term credit facilities. **Articles to be confirmed against the CBUAE Rulebook** |
| Who may offer it | A company SAMA licenses for BNPL | A licensed bank or finance company, a Restricted Licence Finance Company, or an approved agent of either |
| Currency | SAR only | AED |
| Term | At most 12 instalments; tenant uses 4 × 30 days | At most 12 months, for specific goods or services, no interest (to be confirmed) |
| Consumer limit | SAR 10,000 by rule; tenant uses SAR 5,000 | From the CBUAE text and the institution's policy |
| Age | 18 Hijri years | From the CBUAE text; Gregorian dates |
| Identity | Nafath | UAE Pass, ICP (adapters built on fixtures) |
| Credit bureau | SIMAH, Bayan | AECB (adapter built on fixtures) |
| Merchant registry | Wathq | NER (adapter built on fixtures) |

:::note The client's licence route
The client confirmed it is a licensed institution. Whether it holds a finance company licence directly, a Restricted Licence, or acts as agent of a licensed bank decides which CBUAE provisions bind it. **Confirm the exact route in the room**; it is recorded on the tenant at onboarding and changes the rule set.
:::

## What the client will see

| Act | Minutes | Where | The point |
|---|---|---|---|
| 1. A merchant joins | 6 | Operations workbench | No store transacts until a second person verifies it under a contract |
| 2. A shopper pays later | 8 | Merchant API, then the shopper's screens | The figures are final, in both languages, before acceptance |
| 3. What booking did | 3 | The outbox | The merchant is paid net of discount; the bureau is told; each exactly once |
| 4. A purchase is refused | 3 | Shopper's screen | Over the limit: refused with a reason, never a generic decline |
| 5. A merchant is suspended | 4 | Workbench, then the API | Its next checkout is refused at once; reinstated by the same authority |
| 6. Where the rules live | 4 | Catalogue and disclosure | Every limit is configuration with a citation; the UAE delta |

## Before the day

### Why the demonstration runs on the presenter's machine

Run it locally, not on the hosted site. On the hosted site, three things stop this journey today:

- the merchant API's credential is a development stand-in, refused under a deployed profile (SR-004), so no checkout can be opened;
- hosted staff sign-in waits on a verified OIDC call, so the workbench cannot be entered as maker and checker;
- the hosted database is switched to **AE** (approved 12 October 2026), and the BNPL demonstration bank is a Saudi tenant, so its staff are refused with `TENANT_NOT_ACTIVE`.

The local set-up below uses its own database on your machine. It needs no internet connection after `npm ci`, except for the shop's return page.

### The machine

- macOS with **Docker Desktop** running, **Node 22**, **Git**, `jq` and a current browser.
- The repository cloned at `~/Projects/Sanad` on branch `journey-b1-intake-contact-channels`, with `npm ci` run.
- The root `.env.local` holding `MERCHANT_DEV_TOKEN`, `STAFF_DEV_TOKEN_MAKER` and `STAFF_DEV_TOKEN_CHECKER`. Copy it from the engineering lead; never paste it into chat or e-mail.
- Two browser windows: an ordinary one for the **maker** and a private one for the **checker**, so both stay signed in. A third tab in either for the **shopper**.
- Three terminal tabs: `consumer`, `ops`, and `shop` (for the merchant's calls).
- Display at 100% zoom, notifications off, the terminal font enlarged.

### Timeline

| When | What |
|---|---|
| Wednesday 4 November | Full rehearsal on the presenting machine, start to finish, timed. Rebuild the database afterwards (block A) |
| Thursday morning | Pull the branch, `npm ci`, blocks A to C. Sign in once as maker and checker to warm the pages |
| 30 minutes before | Blocks A to C again on a fresh database. Open the windows and tabs below. Do not touch anything else |
| 5 minutes before | Sign in again as checker (the step-up window is five minutes; see Act 5) |

## Setting up

Run the blocks in order. Each takes under two minutes.

### Block A: the demonstration database

In any terminal, from the repository root. It starts an empty PostgreSQL (the same image the CI database job uses) and applies every migration. Starting from empty is what makes the demonstration store appear correctly in block C.

```sh
cd ~/Projects/Sanad
docker rm -f sanad-demo-pg 2>/dev/null
docker run -d --name sanad-demo-pg -e POSTGRES_PASSWORD=demo-local -p 55433:5432 public.ecr.aws/supabase/postgres:17.11.0.002
until docker exec sanad-demo-pg pg_isready -U postgres -h localhost >/dev/null 2>&1; do sleep 2; done; sleep 3
for f in supabase/migrations/*.sql; do docker exec -i -e PGOPTIONS='-c client_min_messages=warning' sanad-demo-pg psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 -q < "$f" >/dev/null || echo "STOP: $f failed"; done; echo "database ready"
```

You should see `database ready` and no `STOP` line.

### Block B: the two applications

In the `consumer` tab:

```sh
cd ~/Projects/Sanad && set -a && source .env.local && set +a
export SANAD_DATABASE_URL=postgresql://postgres:demo-local@localhost:55433/postgres
npm run dev:consumer
```

In the `ops` tab, the same first two lines, then `npm run dev:ops`.

The consumer app answers on `http://localhost:3003`, the workbench on `http://localhost:3001`. The first page of each takes 10–20 seconds to compile; open both once now.

:::warn Both lines matter
Without `source .env.local` the merchant API answers 401 `CREDENTIAL_NOT_RECOGNISED`. Without the `export` line the apps use the shared development database, which is switched to AE, and the workbench refuses the Saudi demonstration bank's staff.
:::

### Block C: the merchant's terminal

In the `shop` tab. This defines `checkout`, the merchant's API call, and makes the first call, which writes the demonstration store (**Demo Store**, `mer-demo-01`) to the empty database.

```sh
cd ~/Projects/Sanad && set -a && source .env.local && set +a
checkout() { curl -s -X POST http://localhost:3003/api/checkout/v1/sessions \
  -H "Authorization: Bearer $MERCHANT_DEV_TOKEN" -H "Idempotency-Key: $(uuidgen | tr A-Z a-z)" \
  -H 'Content-Type: application/json' \
  -d "{\"merchantOrderRef\":\"$1\",\"basket\":{\"minorUnits\":\"$2\",\"currency\":\"SAR\"},\"returnUrl\":\"https://example.com/shop/return\",\"cancelUrl\":\"https://example.com/shop/cancel\"}" | jq; }
checkout WARM-UP-0001 120000
```

You should see `"state": "CREATED"` and a `redirectUrl`. Amounts are minor units: `120000` is SAR 1,200.00.

:::warn Order matters
Make the warm-up call **before** onboarding any merchant. The demonstration store is written only while the merchants table is empty. If you onboarded first, the next call answers 422 `MERCHANT_NOT_ACTIVE`: run block A again and restart block B.
:::

### Windows to have open

- **Maker** window: `http://localhost:3001/en/sign-in`, signed in with the value of `STAFF_DEV_TOKEN_MAKER`, then **Products → Merchants & checkout**.
- **Checker** private window: the same, with `STAFF_DEV_TOKEN_CHECKER`.
- **Shopper** tab: empty, ready for the redirect URL.

Workbench sessions last 30 minutes from sign-in, whatever the activity. Sign in no earlier than 10 minutes before you start.

\pagebreak

## The demonstration script

### Act 1: a merchant joins (6 minutes)

| Step | Do | Say | You should see |
|---|---|---|---|
| 1.1 | Maker window, **Merchants & checkout**. Point at Demo Store | "A store can only sell on instalments once it is onboarded, verified and under contract" | Demo Store, *active*, verified by a different person under contract `AGR-DEV-0001` |
| 1.2 | In **Onboard a merchant**, enter CR `4030024680`, category `RETAIL_FASHION`, English name `Desert Rose Perfumes`, Arabic name `عطور وردة الصحراء`, settlement account `hub-acct-ref-desertrose-01`. **Begin onboarding** | "The settlement account is a reference into the payments hub, never an account number" | "Onboarding begun. The merchant cannot transact until a second person verifies it." The new card shows *awaiting verification* |
| 1.3 | Scroll to the new card, still as maker | "I keyed it, so I cannot approve it. The screen knows that, and so does the server" | The verification form is greyed out: "This needs the checker or senior checker authority, which your session does not hold." |
| 1.4 | Checker window, refresh. On the new card enter store contract `AGR-2026-0109`, registry lookup `REG-LOOKUP-DEMO-03`, screening result `SCR-DEMO-03`. **Verify and activate** | "Four eyes is between people, by identity. The contract reference is required; without it the store cannot be activated" | The card turns *active*, with **Verified by** `stf-checker-01` |

<p><img src="assets/bnpl-demo/06-onboard-merchant.png" width="620" alt="Onboarding form"></p>

<p><img src="assets/bnpl-demo/07-maker-cannot-verify.png" width="620" alt="The maker cannot verify"></p>

<p><img src="assets/bnpl-demo/08-checker-verifies.png" width="620" alt="The checker verifies"></p>

:::note If asked about the registry and screening fields
They are typed here because the registry (Wathq in Saudi Arabia, NER in the Emirates) and screening rails are not yet live. In production the adapters supply them and the checker only confirms. Say exactly that.
:::

### Act 2: a shopper pays later (8 minutes)

| Step | Do | Say | You should see |
|---|---|---|---|
| 2.1 | `shop` tab: `checkout DEMO-ORDER-1001 120000` | "This is the merchant's server calling ours at checkout. No customer data crosses: an order reference and a basket amount" | `"state": "CREATED"`, a `sessionId` and a `redirectUrl` |
| 2.2 | Copy the `redirectUrl` into the shopper tab | "The shop sends the shopper to us" | The Arabic sign-in page |
| 2.3 | Applicant reference `demo-shopper-01`; **Continue with national identity** | "In production this is the national identity login: Nafath in the Kingdom, UAE Pass in the Emirates. Here it is a labelled stand-in" | "Pay later for your order DEMO-ORDER-1001", SAR 1,200.00 |
| 2.4 | Walk the disclosure top to bottom | "Every figure is final and nothing is added later. Four instalments of SAR 300. APR is 0.00%, and the platform computed it anyway: one function computes APR for every product. No fees. Total cost of credit zero" | 4 × SAR 300.00, APR 0.00%, total payable SAR 1,200.00, term 120 days, no fees, a disclosure version |
| 2.5 | Switch the language (**العربية** / **English**) | "Arabic first, right to left, with Arabic numerals; the same figures, the same version" | The mirrored layout, same disclosure version |
| 2.6 | Tick "I have read the disclosure…", then **Accept and complete the purchase** | "The acceptance records which disclosure version the shopper saw" | The browser returns to the shop's page with `state=BOOKED` in the address |

<p><img src="assets/bnpl-demo/02-disclosure-en.png" width="560" alt="Disclosure in English"></p>

<p><img src="assets/bnpl-demo/03-disclosure-ar.png" width="560" alt="Disclosure in Arabic"></p>

:::note The return page
`example.com` stands in for the merchant's own order-confirmation page. Point at the address bar: the shop learns the outcome from the redirect and from a signed callback, never from the shopper's browser alone.
:::

### Act 3: what booking did (3 minutes)

| Step | Do | Say | You should see |
|---|---|---|---|
| 3.1 | `shop` tab: `curl -s -X POST http://localhost:3003/api/internal/outbox \| jq '.ledger[-2:]'` | "Booking does not call anyone directly. It writes instructions to an outbox in the same transaction, and a dispatcher sends each exactly once, keyed so a retry can never pay twice" | `payments.disburse` "115200 SAR to mer-demo-01" and `bureau.report` "OPENED txn_…" |
| 3.2 | Point at the amount | "1,200 less the merchant's 4% discount: 1,152 to the store. The shopper pays 1,200 and nothing more" | `115200` (minor units) |
| 3.3 | Maker window, refresh Merchants | "Operations sees each store's checkouts by state" | Demo Store: Checkout sessions, *booked* among them |

:::warn This endpoint is development-only
`/api/internal/outbox` runs one dispatch pass with stand-in payment and bureau ports and returns 404 under a deployed profile. Do not describe it as a production screen.
:::

### Act 4: a purchase is refused (3 minutes)

| Step | Do | Say | You should see |
|---|---|---|---|
| 4.1 | `shop` tab: `checkout DEMO-ORDER-1002 650000`, open its `redirectUrl` in the shopper tab | "Now a basket of SAR 6,500, above the Saudi demonstration bank's SAR 5,000 limit per shopper. In the Emirates the limit would come from the CBUAE's rules and your policy" | "This purchase would take you over the buy-now-pay-later limit.", control `OP-LIMIT`, **Back to the shop** |
| 4.2 | Switch to Arabic | "Never a generic decline: the reason, in the shopper's language, with the control that refused it" | The Arabic refusal, same control |

<p><img src="assets/bnpl-demo/04-limit-refusal-en.png" width="560" alt="Limit refusal in English"></p>

<p><img src="assets/bnpl-demo/05-limit-refusal-ar.png" width="560" alt="Limit refusal in Arabic"></p>

### Act 5: a merchant is suspended (4 minutes)

:::warn Sign in again first
Suspending and reinstating need a sign-in within the last **five minutes** (step-up). If the checker signed in earlier, sign out and in again just before this act, or the action is sent to the step-up page.
:::

| Step | Do | Say | You should see |
|---|---|---|---|
| 5.1 | Checker window, Demo Store: reason `Customer complaint under review`, **Suspend** | "A complaint arrives. The checker suspends the store, with a reason" | Demo Store *suspended* |
| 5.2 | `shop` tab: `checkout DEMO-ORDER-2001 120000` | "The store's very next checkout call" | 422 *Refused*: "This merchant is not active.", reason `MERCHANT_NOT_ACTIVE` |
| 5.3 | Checker window: **Reinstate** | "Reinstated by the same authority, with an audit trail of both" | Demo Store *active* |
| 5.4 | `shop` tab: `checkout DEMO-ORDER-2002 120000` | "And it trades again" | `"state": "CREATED"` |

<p><img src="assets/bnpl-demo/09-merchant-suspended.png" width="620" alt="A suspended merchant"></p>

### Act 6: where the rules live (4 minutes)

| Step | Do | Say |
|---|---|---|
| 6.1 | Maker window: **Products → Catalogue & disclosure**, the BNPL card | "The product is a term sheet: four instalments, thirty days apart, a SAR 5,000 limit set under SAMA's SAR 10,000 ceiling, a 4% merchant discount, zero to the shopper. It is configuration, effective-dated, changed under four eyes" |
| 6.2 | The worked example under it | "Every figure is produced by the engine; the screen only renders it" |
| 6.3 | Return to the table in *The position, in one page* | "For the Emirates the rule set is the CBUAE's, not SAMA's: currency, limits, age rule, identity, bureau and registry rails, and the citations all change, and that is development work in the BNPL module. The journey you have just seen, and the controls, do not change" |

Close with the next step: a short scoping session to confirm the licence route and the CBUAE provisions, then a dated plan for the UAE rule set.

\pagebreak

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `checkout` answers 401 `CREDENTIAL_NOT_RECOGNISED` | `.env.local` not sourced in the `shop` tab, or a typo in the variable | Re-run the first line of block C, then redefine `checkout` |
| `checkout` answers 422 `MERCHANT_NOT_ACTIVE` without a suspension | Demo Store was never written (a merchant was onboarded before the warm-up), or it is still suspended | Reinstate it as checker; if it is not listed, run block A, restart block B, then block C |
| Workbench sign-in returns `TENANT_NOT_ACTIVE` | The app is on the shared database (AE), not the demonstration one | Stop the app, run the `export SANAD_DATABASE_URL=…` line, start it again |
| Verify, Suspend or Reinstate opens the step-up page | More than five minutes since sign-in | Sign out and sign in again as checker; repeat the action |
| The shopper page does not show the offer | The checkout session expired (30 minutes) or the consumer app restarted | Make a new `checkout` call and use its new URL |
| A page takes 20 seconds the first time | Development compilation | Open every page once during set-up |
| Port 3001 or 3003 already in use | A previous run is still going | `lsof -ti tcp:3001 \| xargs kill` (or 3003), then block B |
| Docker errors in block A | Docker Desktop not running | Start Docker Desktop, wait for it, repeat block A |

If a step fails in front of the client, say what it is ("a development stand-in has expired"), move to the next act, and come back to it at the end.

## Questions and answers

| Question | Answer |
|---|---|
| Is this compliant with the CBUAE's BNPL rules? | What you saw is a Saudi product under SAMA's rules, which do not apply in the UAE, so the question does not arise for it. A UAE product is built to the CBUAE's rules, and no limit goes live without its CBUAE article cited. We do not claim CBUAE compliance for anything until then. |
| Can it run in dirhams? | The platform already runs in AED: our UAE SME finance product works in dirhams on the same engine. The BNPL module refuses any currency but SAR by design; lifting that is part of the UAE rule set. |
| Does it use UAE Pass and AECB? | The UAE Pass, ICP, AECB and NER adapters are built and tested against recorded fixtures. Each stays marked blocked until a live sandbox call has been verified with the institution's credentials. |
| Is the shopper charged anything? | No. The shopper pays the basket price in instalments; the merchant pays the discount. The platform still computes and shows APR, at 0.00%. |
| Is it Shariah-compliant? | The BNPL module is configured as a conventional product with no profit to the shopper. How the merchant discount is treated is for the institution's Shariah board; its ruling becomes configuration, as for our Islamic products. |
| What does the merchant integrate? | One API: open a checkout session with an order reference and a basket amount, then receive the outcome by redirect and by signed callback. It is idempotent on a key the merchant chooses. |
| Where is the data held? | The demonstration holds synthetic data only. A production deployment is placed where the institution's regulator requires, in the institution's own environment if it wishes. |
| How long to a UAE pilot? | Once the licence route and the CBUAE provisions are confirmed, we will give a dated plan. Do not commit to a date in the room. |
| Can it connect to our core banking and payments? | Payments go through one port; the institution's hub or partner bank decides the rail. For core banking, be precise: our SME loans book into Tuum through a built adapter, but **a BNPL purchase is not booked in a core system today**. It is held in SANAD, with the merchant payment and the bureau report queued. Booking BNPL into the core is part of the work. |
| Who services the instalments? | Not yet, for BNPL. SANAD services SME loans (repayments, late charges, restructuring); BNPL instalment servicing (the schedule, collection, reminders and bureau updates) is still to be built. Say so; do not imply it. |

## What not to say or show

- Do not say "CBUAE-compliant", "live" or "integrated with" about any rail. Every rail is on fixtures.
- Do not say a BNPL purchase is booked in Tuum or any core system, or that BNPL instalments are serviced. Neither is built.
- Do not open the hosted site, the Admin jurisdiction screen or the module map's blocked items during the BNPL story.
- Do not show `.env.local`, a token or the terminal history.
- Do not name another client, bank or fintech, including the Saudi demonstration tenants' real-world equivalents.
- Do not promise a delivery date for the UAE rule set.

## After the demonstration

| Item | Owner | Note |
|---|---|---|
| Confirm the client's licence route (finance company, Restricted Licence, or agent) | Pre-sales | Decides the CBUAE provisions that bind it |
| Obtain the current CBUAE Rulebook text for short-term credit facilities and cite each limit | Pre-sales with counsel | A limit with no citation is a guess |
| Scope the UAE BNPL rule set: per-jurisdiction rule pack, AED, Gregorian age rule, UAE Pass, AECB, NER, a UAE consumer tenant | Engineering | Follows the UAE SME pattern |
| Refuse BNPL checkout on a deployment whose jurisdiction does not offer it | Engineering | Found in rehearsal: the consumer checkout booked a SAR purchase on the AE-switched development database. Not shown to the client |

## Sources for the UAE position

The UAE statements above rest on public summaries, not on the rulebook text. Confirm every provision against the CBUAE Rulebook before it is quoted to the client or configured.

- CBUAE, *CBUAE introduces framework for the regulation of short-term credit facilities* (press release).
- White & Case, *UAE Central Bank introduces regulatory framework for buy-now, pay-later providers*.
- Hadef & Partners, *The Central Bank of the UAE issues its regulatory framework for short-term lending*.
- Al Tamimi & Company, *Finance Companies Regulation update regulating BNPL entities*.

Sources disagree on the effective date (29 September or 27 December 2023). The rulebook decides.
