# Object storage

**Port:** `core/ports/object-storage.ts`. **Capability:** `OBJECT_STORAGE`. **Vault provider:** `S3_STORAGE`.
**Status:** `LIVE` against Supabase Storage (development, synthetic data) since 2026-10-15 — STORAGE-01 below.

| Implementation | Where | Use |
|---|---|---|
| `s3/adapter.ts` — `S3ObjectStorage` | any S3-compatible store, Signature V4 (`s3/sigv4.ts`), path-style | Supabase Storage for development and UAT (synthetic data only, ADR 0004); an in-country S3-compatible store in production |
| `memory.ts` — `InMemoryObjectStorage` | process memory | tests, and the synthetic demonstration where no store is configured. Labelled **Fixture** on screen. Lost on restart. |

The ops app picks the S3 store when the tenant's `bucket` credential is in the
vault, else the fixture store only where a synthetic demonstration is permitted,
else none, and an upload is refused as `STORAGE_UNAVAILABLE`
(`apps/ops/src/server/business-storage.ts`).

## Credentials

Saved through Admin → Credentials (or `config.set_integration_credential`), provider
`S3_STORAGE`, one row per key:

| Key | Example |
|---|---|
| `endpoint` | `https://<project>.storage.supabase.co/storage/v1/s3` (https only) |
| `region` | `ap-south-1` |
| `bucket` | the bucket's name; the bucket is **private** |
| `access_key_id` | |
| `secret_access_key` | |

Read from the vault on every call, never cached, logged or returned.

## Rules the adapter keeps

- **Content-addressed.** Key `<tenant>/business/<applicationId>/<sha256>`. No file name, no party.
- **Hash checked both ways.** A put whose bytes do not hash to the key is refused; a get whose bytes do not hash to the record is refused (`OBJECT_TAMPERED`) and never served.
- **The store's error body is never read.** 4xx is `REFUSED` with `HTTP_<status>`; 5xx, timeout, network or an open circuit is `UNAVAILABLE`.
- **No SDK.** The signer is ~100 lines and reproduces AWS's published GET Object example (`test/adapters/s3-sigv4.test.ts`).

## Verification item

**STORAGE-01**, which only a call against the real store can answer:

- that Supabase Storage's S3 endpoint accepts the path-style, header-signed PUT and GET as built (region `ap-south-1`, service `s3`);
- whether it requires `x-amz-content-sha256` to be the payload hash (as sent) or accepts `UNSIGNED-PAYLOAD`;
- that the stored `content-type` is returned on GET;
- what a missing bucket or a revoked key returns (expected 404 / 403 → `REFUSED`).

## STORAGE-01 — verified 2026-10-15

A live call through `S3ObjectStorage`, with every credential read from the vault
(provider `S3_STORAGE`, environment `sandbox`), against the development project's
Supabase Storage S3 endpoint, region `ap-south-1`:

| Call | Result |
|---|---|
| PUT of an 82-byte synthetic PDF, key `<tenant>/verification/STORAGE-01/<sha256>` | 200 → `ANSWERED` |
| GET of the same key | 200, 82 bytes, `content-type: application/pdf` returned, hash matches → `ANSWERED` |
| GET of a key that does not exist | 404 → `REFUSED HTTP_404` |

What this settles:

- Supabase Storage accepts the path-style, header-signed SigV4 request as built (service `s3`, region `ap-south-1`).
- It accepts `x-amz-content-sha256` as the payload hash; `UNSIGNED-PAYLOAD` was not needed.
- The stored `content-type` comes back on GET.
- A missing object is a 404, so it reads as a refusal, never as an outage.

Not yet observed: a revoked key's answer (expected 403 → `REFUSED`). The verification
object was left in the bucket; it is synthetic and content-addressed.

## Open items

- **Residency.** `ap-south-1` is outside both jurisdictions: synthetic data only. A deployment holding customer data needs an in-country store, and `config.deployment_profile` should assert the store's region against the jurisdiction.
- **Key scope.** Supabase's S3 access keys reach every bucket in the project. Production needs a key limited to its bucket.
- **Malware scanning** of uploads is not done here. It belongs before a document is validated, through a scanning port.
