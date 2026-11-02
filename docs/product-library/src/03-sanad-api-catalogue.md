---
title: API Catalogue
subtitle: Every interface SANAD exposes to partners, merchants, upstream systems, payment rails and the institution's own staff.
edition: Kingdom of Saudi Arabia · United Arab Emirates
classification: Client — technical
version: 1.0
date: 27 October 2026
---

## About this catalogue

This catalogue lists every interface SANAD (سند) exposes, who calls it, how it is secured and what it accepts and returns. It is written for the integration teams of an institution, its partners and its merchants, and for IOTA's own solution architects.

The source of truth is the OpenAPI 3.1 specification in the product repository (`api/openapi/`). Each handler is verified against its specification by contract test; where the two disagree, the specification wins and the handler is the defect. An OpenAPI 3.0 artefact for IBM API Connect is generated from the same files, and the constraints 3.0 cannot express are listed inside it.

| API | Who calls it | Base path | Authentication | Jurisdiction |
|---|---|---|---|---|
| Origination API | Partner systems, embedded aggregators | `/origination/v1` | mTLS + OAuth 2.0 client credentials | KSA (Wasl requests) |
| Business applications (part of the Origination API) | The institution's upstream customer-record system | `/origination/v1/business-applications` | mTLS + OAuth 2.0, `business:*` scopes | KSA and UAE |
| Review API | The institution's internal systems and workbench | `/review/v1` | mTLS + staff OpenID Connect | KSA and UAE |
| Merchant checkout API | Merchants offering buy now, pay later | `/checkout/v1` | mTLS + OAuth 2.0, `checkout` scope | KSA |
| Rail callbacks (webhooks) | SADAD, the payments hub, the partner bank | `/api/wasl/v1/webhooks`, `/api/business/v1/webhooks` | `Sanad-Signature` HMAC | KSA and UAE |
| Files and exports | Signed-in staff | Workbench paths | Staff session | KSA and UAE |

The rails SANAD itself calls (Nafath, SIMAH, UAE PASS, Tuum, Nutrient and the rest) are not public interfaces of SANAD. They sit behind internal ports and are described in the Product Guides.

## Design principles

Six properties hold across every interface. They are load-bearing, not stylistic.

1. **Closed schemas.** Every request schema is `additionalProperties: false`. An unknown field is refused, not ignored. A field that should not exist cannot be smuggled in by a client that sends it anyway.
2. **Money is a string of minor units.** `{"minorUnits": "9800000", "currency": "SAR"}`. Never a JSON number, which most parsers read as a floating-point double. A string of digits survives every parser intact.
3. **The client never names its tenant, channel or identity.** There is no `tenantId`, `channel` or `partnerId` in any body. All three are derived from the authenticated credential. Supplying one is refused.
4. **No gateway header carries meaning.** IBM API Connect fronts SANAD today; another institution's gateway may not. The service re-validates identity and tenant itself and trusts no header a gateway injects.
5. **Every state-changing call carries an `Idempotency-Key`.** The same key with the same body returns the original answer. The same key with a different body is refused with `409`.
6. **Every refusal names its control.** Errors are RFC 9457 problem details with a stable `reason`, the `control` that refused, and the explanation in both English and Arabic. There is no generic decline.

### Common headers

| Header | Direction | Required | Purpose |
|---|---|---|---|
| `Authorization: Bearer …` | Request | Yes | OAuth 2.0 access token (client credentials or staff OpenID Connect) |
| `Idempotency-Key` | Request | On every `POST` and `PUT` | Makes a retry safe. One key, one outcome |
| `X-Correlation-Id` | Request and response | Optional on request | Carried through every log and event. Generated when absent and always returned |
| `Content-Type: application/json` | Request | With a body | |
| `Content-Type: application/problem+json` | Response | On every error | RFC 9457 |

### The problem response

```
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://<institution API host>/problems/control-rejection",
  "title": "Refused by a control",
  "status": 422,
  "detail": "This invoice is already financed by another transaction.",
  "detailAr": "هذه الفاتورة مموّلة بالفعل في معاملة أخرى.",
  "control": "SH-10",
  "reason": "DUPLICATE_FINANCING",
  "correlationId": "4b6f2a0e-…",
  "context": { "existingReference": "WT-000123" }
}
```

`context` carries scalars only, and never a personal datum, an identity number or a secret.

## Security

### Partners, merchants and upstream systems

Two schemes apply **together**, not as alternatives:

- **Mutual TLS.** A client certificate pinned per integration. It binds the channel. The gateway terminates it and re-asserts it; the service does not accept the gateway's word for it.
- **OAuth 2.0 client credentials.** The token identifies the partner, merchant or upstream system.

| Scope | Grants | Held by |
|---|---|---|
| `origination:read` | Read the requests this credential raised | Partner systems, aggregators |
| `origination:write` | Raise and withdraw requests; check eligibility | Partner systems, aggregators |
| `business:read` | Read SME business applications of the credential's institution | Upstream customer-record system |
| `business:write` | Hand SME business applications over at stage 5 | Upstream customer-record system only |
| `checkout` | Create, read and cancel checkout sessions | Merchants |

### The institution's staff

Staff authenticate through the institution's own identity provider (OpenID Connect). The subject is the staff member; the institution and their authority (maker, checker, senior checker, credit committee, finance, Shariah reviewer, Shariah auditor, platform administrator) come from the token's group claims, mapped in the institution's staff identity configuration. Four eyes is applied per record, by identity, not by role.

### Rail callbacks

Every inbound callback is verified before its body is parsed:

```
Sanad-Signature: t=<epoch seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

- The timestamp is inside the MAC, so it cannot be moved. A signature more than 300 seconds from the receiver's clock is refused.
- A signature is accepted once. A captured delivery cannot be replayed.
- During a secret rotation several `v1` values may be sent; one matching is enough.
- The secret is the institution's own, held in the vault (key `webhook_secret` under the rail's integration), at least 32 bytes.
- The institution is the one whose secret verified the signature. A body that names one is never read for it.

### Rate limits

Declared in the gateway configuration (`gateway/ibm/`) and enforced there. A limited call is answered `429` with `Retry-After`.

## Origination API

Raise and track origination requests from an integrating system. **An origination request is an instruction to originate, not a credit.** For Wasl Murabaha supply-chain finance, approval buys exactly one thing: the right to open a transaction in `DRAFT`, at the start of a sequence that must validate the trade, hold the limit, execute the purchase, evidence ownership and possession, and hold the goods at the institution's own risk for the Shariah board's interval before any sale is offered.

Review (approve, return, reject) is deliberately absent from this API. Those are institutional acts by named people inside the institution, and are in the Review API.

| Method | Path | Operation | Scopes |
|---|---|---|---|
| `POST` | `/requests` | Raise an origination request | `origination:write` |
| `GET` | `/requests` | List the requests this credential raised | `origination:read` |
| `GET` | `/requests/{requestId}` | Read a request | `origination:read` |
| `PUT` | `/requests/{requestId}/withdrawal` | Withdraw a request still open | `origination:write` |
| `POST` | `/eligibility` | Check eligibility before raising (nothing is stored) | `origination:write` |
| `POST` | `/business-applications` | Hand an SME application over at stage 5 | `business:write` |
| `GET` | `/business-applications/{applicationId}` | Read a business application's stage and status | `business:read` |

### POST /requests — raise an origination request

**A request always names a real trade.** There is no amount-only form of this call. A body without a `tradeReference` is refused with `SH-03`. The channel is derived from the credential, and the institution's servicing platform is consulted for credit capacity before a person reviews.

| Field | Type | Required | Notes |
|---|---|---|---|
| `programmeId` | string | Yes | The supply-chain programme (anchor) the trade belongs to |
| `counterpartyId` | string | Yes | The distributor, as onboarded by the institution |
| `tradeReference.type` | `CLEARED_INVOICE` · `PURCHASE_ORDER` | Yes | |
| `tradeReference.invoiceUuid` | string | For a cleared invoice | ZATCA FATOORA identifier |
| `tradeReference.invoiceHash` | 64 hex | Optional | SHA-256 of the cleared document |
| `tradeReference.issuerCr` / `recipientCr` | 10 digits | Yes | Commercial registrations of seller and buyer |
| `requestedAmount` | Money | Yes | The cost to finance |
| `requestedTenorDays` | integer | Yes | Determinate tenor (SH-03) |
| `initiator.kind` | `PARTNER_SYSTEM` · `AGGREGATOR` | Yes | An aggregator also supplies `merchantMandateRef` |
| `partnerReference` | string | No | Your reference, echoed back. Not used for idempotency |

Responses: `201` the request with its `requestId`, `state` and `correlationId` · `400` malformed or closed-schema violation · `401` no valid credential · `403` not entitled · `409` idempotency key reused with a different body · `422` refused by a control · `429` rate limited.

Request states: `KEYING`, `AWAITING_SERVICING_RESPONSE`, `AWAITING_REVIEW`, `RETURNED_TO_MAKER`, `PENDING_INFORMATION`, `SERVICING_UNAVAILABLE`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `EXPIRED`. Once approved and opened, the request carries the `transaction` reference.

### POST /eligibility — check before raising

Runs the institution's credit policy over the facts supplied and the facts the institution already holds, and answers with the outcome the engine would reach today: `APPROVE`, `DECLINE` or `REFER`, with reason codes, the policy and its version. **Nothing is persisted and no request is created** (`persisted` is always `false`). A pre-check, not a promise.

### PUT /requests/{requestId}/withdrawal

The only state change a partner may cause after raising. Available while the request is open; once decided, the call is refused with `422`. Idempotent: withdrawing a withdrawn request is the same outcome.

### POST /business-applications — SME hand-over at stage 5

For an institution that lends to businesses directly. Stages 1–4 (application, needs assessment, product application, verification) happen in the institution's own customer-record system; this call hands the verified application to SANAD's credit team at stage 5.

| Field | Type | Required | Notes |
|---|---|---|---|
| `applicationId` | `ABC-000000` | Yes | The institution's application reference |
| `upstreamRef` | string | Yes | The upstream record. A second hand-over with the same value answers `200` with the application |
| `applicant.businessNameEn` / `businessNameAr` | string | En required | |
| `applicant.registrationRef` | string | Yes | Trade licence or CR as verified upstream |
| `applicant.sector` | code | Yes | The jurisdiction's SME sector code |
| `applicant.yearsInOperation` | integer | Yes | |
| `applicant.owners[]` | `{displayName, ref}` | Yes | Opaque references. **Never an identity number** |
| `applicant.upstreamVerificationRefs[]` | string | Yes | What stage 4 verified upstream (identity, registry, bureau consent) |
| `productCode` | `sme-term-conventional` · `sme-term-islamic` | Yes | Must be enabled in the institution's catalogue |
| `variantCode`, `purpose` | code | Yes | From the product's term sheet |
| `requestedMinorUnits` | string | Yes | In the institution's base currency (halalas or fils) |
| `tenorMonths`, `graceMonths` | integer | Tenor required | |
| `contributionPerTenThousand` | integer | No | The owner's own contribution, per ten thousand of project cost |
| `contact.partyRef` | string | No | Masked email and mobile only; the delivery adapter resolves the real destination |

**Tenant and currency are not in the body.** Both follow from the credential and the institution's onboarding record. Responses: `201` received · `200` already handed over under this `upstreamRef` · `409` nothing saved (retry with the same key) · `422` refused by a control, for example a product not enabled, or new business not permitted by the installation's licence.

### GET /business-applications/{applicationId}

Returns `status` (`RECEIVED`, `SPREADING`, `SUBMITTED`, `ASSESSED`, `IN_COMMITTEE`, `APPROVED`, `DECLINED`, `OFFER_SENT`, `SIGNED`, `DISBURSED`, `WITHDRAWN`), `stage` (5 credit assessment, 6 decisioning, 7 contract and disbursement, 8 portfolio, 9 collections), the requested amount and tenor as handed over (never overwritten), `approvedTerms` once approved (the committee may approve less), `currency` (`SAR` or `AED`) and `offerLetterVersion` (the SHA-256 of the letter sent).

## Review API (internal)

For the institution's own systems and the operations workbench. The principal is the authenticated staff member; the institution and the approval authority come from the token, never from the body.

| Method | Path | Operation |
|---|---|---|
| `GET` | `/queue` | The requests waiting on the institution, oldest first |
| `GET` | `/requests/{requestId}` | One request, with what a reviewer needs to decide |
| `PUT` | `/requests/{requestId}/decision` | Approve, return, reject, or ask for information |
| `PUT` | `/requests/{requestId}/servicing-retry` | Retry the servicing platform for a request it could not reach |

**Decisions.** `decision` is `APPROVE`, `RETURN` (needs `note`), `REJECT` (needs `reasonCode`) or `REQUEST_INFORMATION` (needs `from`: `COUNTERPARTY`, `PARTNER` or `DOCUMENTS`, and `items`). Approving against a servicing decline requires `contraryJustification`.

**Refusals.**
- A decision on the principal's own work is refused (`OWN_WORK`).
- An approval beyond the principal's authority is refused (`APPROVAL_AUTHORITY_INSUFFICIENT`). The tiers are checker, senior checker and credit committee, set per institution in its origination policy.

**Servicing retry.** The platform retries automatically within the institution's retry policy. Beyond it, a named person retries, with a recorded note.

## Merchant checkout API (buy now, pay later)

For merchants offering SANAD's BNPL product at checkout. Saudi Arabia.

| Method | Path | Operation |
|---|---|---|
| `POST` | `/sessions` | Create a checkout session for a basket |
| `GET` | `/sessions/{sessionId}` | Read a session |
| `PUT` | `/sessions/{sessionId}/cancellation` | Cancel a session the shopper has not accepted |

**POST /sessions.** Body: `merchantOrderRef`, `basket` (Money), `returnUrl` and `cancelUrl` (https only), optional `shopperHint`, an opaque reference the merchant already holds; never an identity number or phone. The basket is the financing amount; there is no other amount field. The response carries `redirectUrl`, where the shopper is sent.

**What the shopper does.** The shopper is identified (Nafath), sees the full disclosure, including the APR, every fee and the total payable, and accepts or declines.

**Session lifecycle.**
- The session expires if the shopper does not accept within the institution's window.
- The merchant may cancel it until the shopper accepts. After acceptance, cancellation is refused with `422`.
- Sessions carry `acceptanceRef` once accepted and `transactionId` once booked.
- A refused session carries the control that refused it. It never carries a score or a reason about the shopper.

**Licence gate.** A merchant whose installation licence does not permit BNPL is refused with `OP-LICENCE`.

## Rail callbacks (webhooks)

Inbound results from the payment and collection rails. Every one is signed (`Sanad-Signature`, above), limited to 16 KB, and recorded once.

| Method | Path | Sender | Reports |
|---|---|---|---|
| `POST` | `/api/wasl/v1/webhooks/collection-results/{tenant}` | SADAD | A presented Wasl bill paid or returned |
| `POST` | `/api/wasl/v1/webhooks/payment-results/{tenant}` | Payments hub | A seller payment accepted, settled, rejected or returned |
| `POST` | `/api/business/v1/webhooks/collection-results/{tenant}` | SADAD (KSA) · partner bank (UAE) | An instalment collection paid or returned |
| `POST` | `/api/business/v1/webhooks/payment-results/{tenant}` | Partner bank (UAE) · payments hub | A released tranche settled, rejected or returned |

**Collection result body.** `transactionRef` (Wasl only), `idempotencyKey` (the presentation's own key, for example `wasl:WT-000123:collect:I1`), `status` (`PAID` or `RETURNED`), `reference`, `receivedOn` (yyyy-mm-dd), optional `amountMinorUnits`.

**Payment result body.** `transactionRef` or the application reference, `instructionRef` or `idempotencyKey`, `status` (`ACCEPTED`, `SETTLED`, `REJECTED`, `RETURNED`), optional `reasonCode`.

**How a result is routed.** The key decides where a result goes. An instalment's receipt reduces what is owed. A late amount's receipt goes to the segregated charity liability (KSA, Wasl) and never to the obligation. When an instalment is paid, its share of any income being purified is raised to charity.

| Response | Meaning |
|---|---|
| `204` | Recorded, or the same result already recorded |
| `400` | Malformed body |
| `401` | Signature missing, invalid, outside tolerance or replayed |
| `404` | Unknown institution or subject |
| `413` | Body larger than 16 KB |
| `422` | Refused by a control. Operations resolves it |
| `503` | The core banking platform could not take a charity posting. Nothing was recorded; deliver again |

## Files and exports

For signed-in staff only, in their own institution. No path accepts an institution as a parameter.

| Method | Path | Returns | Who |
|---|---|---|---|
| `GET` | `/api/business/v1/applications/{id}/documents/{sha256}` | An uploaded document, by the hash of its bytes | Staff |
| `GET` | `/api/business/v1/applications/{id}/letters/{sha256}` | A rendered offer-letter PDF, by its hash | Staff |
| `GET` | `/api/documents/v1/artefacts/{documentId}` | A document's bytes for the in-browser viewer | Staff |
| `GET` | `/{locale}/business/export` | The SME pipeline as CSV (business fields only; injection-safe) | Staff |
| `GET` | `/{locale}/shariah/audit/{transactionRef}/pack` | A transaction's Shariah audit pack (JSON with SHA-256 manifest) | Shariah auditor, reviewers |
| `GET` | `/{locale}/shariah/report/export?from=&to=` | The Board's Shariah compliance report for a period (JSON) | Shariah auditor, reviewers |
| `GET` | Admin `/{locale}/licence/request` | The installation's licence request file | Platform administrators |

## Control codes

Every refusal names the control that produced it. The Shariah controls apply to Islamic products; the operational ones to all.

| Code | Meaning |
|---|---|
| `SH-01` | No riba: return is a profit amount, never a rate (Murabaha) |
| `SH-02` | No riba on default: an executed total never increases |
| `SH-03` | No gharar: determinacy before execution (a trade, an amount, a tenor) |
| `SH-04` | No maysir: no contingent pricing or optionality |
| `SH-05` | No sale before ownership |
| `SH-06` | Genuine ownership risk: the risk-holding interval |
| `SH-07` | Separation of contracts: one leg, one document |
| `SH-08` | No ‘inah: seller, buyer and institution are distinct |
| `SH-09` | No sale of debt |
| `SH-10` | No duplicate financing: an invoice is financed once |
| `SH-11` | Permissible goods only |
| `SH-12` | Permissible counterparty activity |
| `SH-13` | Late amounts and impermissible income are charity, never income |
| `SH-14` | Forbearance for genuine hardship |
| `SH-15` | Disclosure of cost and profit |
| `SH-16` | Takaful only |
| `SH-17` | Fatwa-bound operation: no origination without an approval in force |
| `SH-18` | Auditability by the Board |
| `OP-DETERMINACY` | A required value is absent or indeterminate |
| `OP-CHAIN` | A hash chain or timestamp order is broken |
| `OP-LIMIT` | A limit or concentration rule would be exceeded |
| `OP-LICENCE` | The installation's licence does not permit new business |
| `PLAT-02` | Floating point in the financial path |
| `PLAT-03` | A stale, missing or unsourced rate |

## Environments, versioning and onboarding

**Environments.** Sandbox, UAT and production, each with its own base URL (`https://api.{environment}.…/origination/v1`), its own credentials and certificates, and its own webhook secrets. Development and UAT hold synthetic data only. An environment that holds customer data is an in-Kingdom deployment for a Saudi institution.

**Versioning.** The major version is in the path (`/v1`). Within a version, changes are additive: a new optional response field, a new endpoint, a new enumerated value announced in advance. A breaking change is a new major version, run alongside the old one for an agreed period.

**Onboarding an integration.**
1. IOTA and the institution agree the scopes and the channel.
2. The institution issues the client certificate and the OAuth client.
3. The integration runs against the sandbox with recorded fixtures for every rail.
4. The contract tests are run against the integration's own calls.
5. The institution's change board promotes it to UAT, then production.

:::note A note on the hosting of these interfaces
In the current development build, the partner and merchant interfaces are hosted inside the operations workbench and consumer applications, so every channel lands in the same queue. In a production deployment they run as the origination service behind the institution's gateway. The contract does not change.
:::

---

*This material is general information about IOTA Technologies' services and is not legal, regulatory or compliance advice, nor a compliance opinion on any specific circumstance. References to SAMA, the CBUAE, NDMO, PDPL and NCA are context. Engagements are governed by separate written agreements.*
