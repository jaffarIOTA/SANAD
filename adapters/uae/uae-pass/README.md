# UAE Pass — identity authentication

**Port:** `core/ports/identity-authentication.ts`. **Vault provider:** `UAE_PASS`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox (staging) call and the findings are
written here.

## Verification item

**UAE-RAIL-UAEPASS-01** — what only a sandbox call can answer:

- the institution's onboarding as a UAE Pass service provider (client id,
  redirect URIs, scopes) and whether the flow is redirect or app-to-app push
  for a server-initiated step-up;
- the envelope the live transport hands the adapter (below) once it has run
  the code exchange and verified the id token;
- which assurance levels count as a verified identity (the adapter treats
  `SOP1` as basic and `SOP2`/`SOP3` as verified, as the published attribute
  list implies);
- the signer process's in-progress status name, its lifetime (the adapter
  allows 900 seconds), and what evidence a finished process returns for the
  signature record.

## Demonstration and assumed contract

Modelled on **the published UAE Pass integration** — <https://docs.uaepass.ae/>:

| Purpose | Published element | Adapter call |
|---|---|---|
| `LOGIN`, `STEP_UP` | OIDC authorisation-code flow, `/idshub/authorize` (`response_type=code`, `scope=urn:uae:digitalid:profile:general`, `acr_values`, `state`, `ui_locales`) | `POST /idshub/authorize` → `{ state, expires_in }` |
| confirm | token endpoint, then `/idshub/userinfo` claims: `sub`, `uuid`, `userType` (SOP1/2/3), `idn` (SOP2/3 only), names, nationality, gender, `idType`, mobile, email | `GET /idshub/userinfo?state=` → `{ id_token: { jti, sub, auth_time }, userinfo: { … } }` or an OAuth `error` (`authorization_pending`, `access_denied`, `expired_token`) |
| `SIGNATURE_INTENT` | `POST /trustedx-resources/esignsp/v2/signer_processes` (`process_type`, `labels`, `signer.signature_policy_id`, `ui_locales`) | → `{ id, tasks.pending[] }` |
| confirm | the signer process read back; result `status` `finished` \| `failed` \| `failed_documents` \| `canceled` | `GET …/signer_processes/{id}` → `{ id, status, finished_at, signer: { sub, userType } }` |

The published parts are the endpoints, scopes, claim names and the signer
result statuses. **Not published, and therefore assumed:** the server-side
envelope (`state`/`expires_in`, decoded `id_token` beside `userinfo`,
`signer`/`finished_at`), the `active` in-progress status, and the enumerations
of `userType`, `gender` and `idType`. They remain the verification item.

The transaction reference the port carries is the adapter's own:
`login:<state>`, `stepup:<state>` or `sign:<process id>` (`UAEPASS-DEV-004`).

The demonstration answers every reference as a verified SOP3 account, except: a
reference containing `basic` is SOP1, `reject` declines (`access_denied` /
`canceled`), `pending` has not completed, and `fail` fails signing.

## What is settled without the sandbox

- A step-up or signing intent completed at SOP1 is `REFUSED` with
  `ASSURANCE_INSUFFICIENT`; an unknown `userType` or signer status is
  malformed, never verified.
- Each assertion is accepted once, fresh, for this tenant (SR-007).
- The Emirates ID, names, mobile and email are dropped at this boundary; only
  the assertion id (`jti`, or the signer process id), the subject (`sub`) and
  the time cross the port. A userinfo `sub` that differs from the id token's
  is malformed.
- The port's signing intent carries no document; attaching the document to the
  signer process needs a port change (`UAEPASS-DEV-003`).
- Unreachable service → `UNAVAILABLE`, which approves nothing.
