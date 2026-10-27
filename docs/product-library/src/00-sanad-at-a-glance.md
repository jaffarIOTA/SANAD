---
title: SANAD at a Glance
subtitle: Loan origination for regulated lenders in Saudi Arabia and the United Arab Emirates.
edition: Datasheet
classification: Client
version: 1.0
date: 27 October 2026
toc: no
layout: compact
---

## What SANAD is

SANAD (سند) is IOTA Labs' loan origination platform for banks, finance companies and fintechs in the Kingdom of Saudi Arabia and the United Arab Emirates. It is one origination engine with pluggable product modules, Islamic and conventional, and a complete set of national integration rails.

It takes an application from first contact to a booked, serviced facility. Along the way it handles identity, bureau, documents, assessment, committee, offer, signature, disbursement and booking in the core banking system. Every institution-specific ruling is configuration: credit policy, products, Shariah board positions, document checklists, approval tiers and service levels.

## Products

| Product | Kingdom of Saudi Arabia | United Arab Emirates |
|---|---|---|
| Murabaha supply-chain finance (Wasl) | Available | — |
| Personal finance (Tawarruq) | Available | — |
| Buy now, pay later | Available | — |
| Embedded lending through partners | Available | — |
| Conventional consumer term finance | Available | — |
| SME term finance (conventional) | Available | Available |
| SME finance (Tawarruq) | On the board's ruling | On the board's ruling |

## What sets it apart

- **Controls that cannot be bypassed.** A Murabaha sale cannot be offered before ownership and possession are evidenced. Four eyes are compared by identity, not by role. No screen or role can override a gate.
- **Shariah governance built in.**
  - A register of Shariah approvals: no approval in force, no new Islamic business.
  - A daily compliance review, with incidents and purification.
  - A read-only audit workspace for the Shariah Board.
- **One APR for the platform.** Every consumer offer carries the full disclosure set in Arabic and English, before acceptance.
- **Arabic first.** Composed right-to-left, with Hijri and Gregorian dates where a date has contractual effect.
- **Your data stays in your jurisdiction.** Residency is enforced by the database, and the platform runs on your own infrastructure.
- **Exact money.** Every amount is held as an integer in minor units, and every rate in basis points.

## Integrations

| Area | Kingdom of Saudi Arabia | United Arab Emirates |
|---|---|---|
| Identity and signing | Nafath, Yakeen | UAE Pass, ICP |
| Credit bureau | SIMAH, Bayan | AECB |
| Business registry | Wathq | NER |
| Employment and tax | GOSI, ZATCA | MOHRE, FTA |
| Bank data | Open Banking | UAE Open Finance |
| Payments and collections | SADAD, the institution's payments hub | The institution's partner bank |
| Core banking | Tuum | Tuum |
| Documents | Nutrient | Nutrient |

Each integration is built to the same pattern: a consent check first, credentials held in the vault, a circuit breaker, and a typed outcome when the service is unavailable. A service that is down never approves anything. Live connections are made with the institution's credentials during implementation.

## Deployment

- **Where it runs:** on the institution's own OpenShift, or on a cloud the institution approves within its jurisdiction.
- **Database:** PostgreSQL, with row-level security on every table.
- **Workflow:** Temporal for durable workflow.
- **Gateway:** IBM API Connect and DataPower, with OpenAPI 3.1 as the source of truth.
- **Staff sign-in:** OpenID Connect against the institution's identity provider, with step-up before approvals.

## How we deliver

**Assess and architect → Design for compliance → Build and integrate → Run and improve.** The teams that build SANAD also run and improve it.

## Contact

IOTA Technologies · Riyadh · Dubai · London
engagements@iotatechnologies.ai · +966 50 534 0573 · iotatechnologies.io

:::note
This datasheet is general information about a product in development. It is not legal, regulatory or Shariah advice. Product availability depends on each institution's configuration, regulatory approvals and board rulings.
:::
