# SANAD

**Sanad** (سند) — Shariah-compliant origination platform.
**Wasl** (وصل) — its first product: SME supply chain finance for the Kingdom of Saudi Arabia.

## Read first

| | |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Build instructions and the non-negotiable invariants. Read before writing code. |
| [`docs/Sanad-Wasl-Solution-Design-v0.2.pdf`](docs/) | The specification — BRD, HLD, architecture, data, backend, frontend. |
| [`docs/SAVING-CREDENTIALS.md`](docs/SAVING-CREDENTIALS.md) | How to store Tuum and Nutrient API keys. |

## Stack

Next.js · Node + TypeScript · Kong (abstracted for IBM API Connect / DataPower) · Redis · Supabase (PostgreSQL)

## Setup

```bash
npm install          # once package.json exists
supabase db push     # apply migrations
```

Then store the provider credentials — see `docs/SAVING-CREDENTIALS.md`. **Never commit a key.**

## Guard rails

A `PreToolUse` hook (`.claude/hooks/invariant-guard.py`) blocks edits that introduce an
interest/rate construct, place a domain table in the `public` schema, hardcode a credential,
or read the server clock inside `sequencing/`. These are structural invariants, not style
rules — see `CLAUDE.md` §1.

## Status

Pre-Phase-0. The design is not frozen: it is subject to the rulings of each deploying
institution's Shariah Supervisory Board, and to the open items in Section 9 of the SDD.
