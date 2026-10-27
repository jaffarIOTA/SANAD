# Timestamping authority — RFC 3161

**Port:** `core/time/tsa.ts` (`TimestampAuthorityPort`). **Status:** `BLOCKED` — E-04, no accredited
authority chosen. The adapter is built and has verified a real authority's token; no tenant enables one yet.

Every instant with contractual effect (a Murabaha leg, the evidence a gate rests on) is an authority's
attestation, so the Board can check the risk-holding interval without trusting the institution's clocks
(SH-06, SDD §3.5.3, §5.6). Until an institution enables its authority, the host clock stands in, labelled
`host-clock`, and only where data is synthetic (SR-006, ADR 0004).

## What it does

- `stamp(sha256Hex)` sends a `TimeStampReq` (SHA-256 imprint, a fresh 64-bit nonce, `certReq`, the
  institution's policy when it names one) over HTTPS (`application/timestamp-query`), and returns the
  attestation **with the token** only once the token has passed every check below. `verify(token,
  sha256Hex)` re-checks a retained token for audit replay.
- Failure is `undefined`, never an exception and never a guess. Why a token was refused is counted on the
  adapter (`refusals`), not returned (SR-008).
- A circuit breaker per authority; egress through an injected `fetch`, so the institution's forward proxy is
  honoured by whoever composes it.

## The checks (`rfc3161.ts`)

1. The TSTInfo's message imprint is SHA-256 over exactly the digest asked for.
2. The nonce comes back unchanged (on `stamp`).
3. The signed attributes name the TSTInfo content type and carry its digest.
4. The signature over the signed attributes verifies with the signer's key.
5. The signer certificate is the one the ESS signing-certificate attribute (v2, or v1) names.
6. Its only extended key usage is time stamping.
7. It chains, through certificates the token carries, to a trust anchor the institution configured, every
   certificate valid **at genTime** (not today).
8. The policy, when the institution names one, is that policy.

Algorithms are an allow-list: SHA-256/384/512, with RSA PKCS #1 v1.5 or ECDSA. Anything else, SHA-1
included, is refused. The DER reader (`der.ts`) keeps each element's exact bytes: signatures are checked
over what was received, never a re-encoding. No dependency.

## Verified (2026-10-28)

| Check | Result |
|---|---|
| A public authority (FreeTSA, `https://freetsa.org/tsr`): request built by `openssl ts -query`, token returned and kept in `fixtures/freetsa-response.tsr` with FreeTSA's root and TSA certificates | Accepted by `verifyToken`: imprint, nonce, signature, ESS binding and chain. Refused for another message, another nonce, another policy, another root, an altered genTime and an altered signature (`test/adapters/tsa.test.ts`) |
| LibreSSL 3.3.6's own `openssl ts -reply` against a throwaway root (`fixtures/libressl-*`) | **Refused, `UNSUPPORTED_ALGORITHM`**: LibreSSL signs the CMS with SHA-1 whatever `signer_digest` says (asn1parse shows `sha1` in the SignerInfo). An authority signing with SHA-1 would be refused the same way |
| The in-process authority (`test/support/test-tsa.ts`): real ECDSA certificates and tokens over any digest | Every refusal driven with genuine signatures: a signer without the time-stamping usage, a signer the ESS attribute does not name, a corrupted signature, a certificate expired at genTime, a replayed nonce, a token for another digest |

Only a SHA-256 of a fixed test string went to FreeTSA. FreeTSA is not an accredited authority and is not
configured for any tenant; it is evidence that the adapter reads a real authority's tokens.

## Verification item

**E-04 / TSA-01** — the accredited authority each institution uses. For it, record here: the endpoint and
how it authenticates callers; the certificate chain to trust; the policy OID; whether it includes its
certificate on request (`certReq`); its accuracy; and a sandbox token verified by this adapter.

## How a tenant uses it

The tenant's `TIMESTAMP_AUTHORITY` rail decides (`services/origination/src/attested-time.ts`):

- **enabled**: this adapter and nothing else. If it is down, or its token fails a check, the step is refused
  with `SH-06 TIMESTAMP_UNAVAILABLE` and nothing is written. The host clock never stands in for it.
- **not enabled**: the host clock, only in development or a declared-synthetic deployment; otherwise no
  instant at all.

The authority's settings are the rail's vault entry (provider `TSA`, migration 0001), read server-side and
audited by the vault: `endpoint_url`, `authority_id`, `trust_anchors_pem` (one or more PEM certificates),
and optionally `policy_oid` and `authorization` (a header value, when the authority authenticates callers).

## What is attested over what

| Instant | Stamped over | Token kept in |
|---|---|---|
| A Murabaha leg's execution | The leg's anchor digest (`products/murabaha-scf/legs/anchor.ts`): its content hash, place, transaction and predecessor | `core.contract_leg.tsa_token` |
| Possession evidence's capture | The uploaded file's SHA-256 | `evidence.evidence.captured_tsa_token` (migration 0036) |
| Ownership evidence (the e-invoicing authority's answer) and every other step | A digest unique to the step | On evidence, `captured_tsa_token`; on an event, not kept |

A leg's content hash does not contain its instant (hash version 2): the instant is the token's genTime over
the anchor, which contains the hash. Legs the host clock made before 28 October 2026 carry version 1 and
still pass the drift check; a leg an authority attested never can.
