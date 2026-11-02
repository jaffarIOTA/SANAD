/**
 * S3-compatible object storage (vault provider S3_STORAGE).
 *
 * One adapter for any store that speaks the S3 object API with Signature
 * Version 4: Supabase Storage in development and UAT (synthetic data only,
 * ADR 0004), an in-country S3-compatible store in production. Path-style
 * addressing (`<endpoint>/<bucket>/<key>`), which every such store accepts.
 *
 * Credentials come from the vault on every call (access_key_id,
 * secret_access_key, endpoint, region, bucket under capability
 * OBJECT_STORAGE) and are never cached, logged or returned. A store's error
 * body is not read: a 4xx is REFUSED with the status as the code, a 5xx, a
 * timeout or an open circuit is UNAVAILABLE. Bytes read back are hashed and
 * refused if they are not the bytes that were stored.
 */
import { createHash } from 'node:crypto';

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { ObjectStoragePort, StorableMediaType, StoredObject } from '../../../core/ports/object-storage.ts';
import { STORABLE_MEDIA_TYPES } from '../../../core/ports/object-storage.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import { CircuitBreaker, CircuitOpenError } from '../../kernel/circuit-breaker.ts';
import { EMPTY_PAYLOAD_SHA256, signRequest } from './sigv4.ts';

export interface S3StorageOptions {
  readonly environment: 'sandbox' | 'uat' | 'production';
  readonly nowEpochSeconds: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** An object key: tenant, purpose and content hash only. No file name, no party. */
const KEY_SHAPE = /^[a-z0-9][a-z0-9-]{1,62}\/[A-Za-z0-9._/-]{1,180}\/[0-9a-f]{64}$/;

const unavailable = <T>(reason: string): Result<RailOutcome<T>> => ok({ kind: 'UNAVAILABLE', reason });
const refused = <T>(code: string): Result<RailOutcome<T>> => ok({ kind: 'REFUSED', code });

export class S3ObjectStorage implements ObjectStoragePort {
  readonly source = 'LIVE' as const;
  readonly #breaker: CircuitBreaker;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly options: S3StorageOptions,
  ) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#breaker = new CircuitBreaker('object-storage', {
      failureThreshold: 5,
      resetAfterSeconds: 30,
      successThreshold: 1,
      nowEpochSeconds: options.nowEpochSeconds,
    });
  }

  async put(params: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
    readonly mediaType: StorableMediaType;
    readonly sha256Hex: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<StoredObject>>> {
    if (!KEY_SHAPE.test(params.objectKey) || !params.objectKey.endsWith(params.sha256Hex))
      return reject('OP-DETERMINACY', 'OBJECT_KEY_INVALID', 'An object key ends in the hash of its bytes');
    if (createHash('sha256').update(params.bytes).digest('hex') !== params.sha256Hex)
      return reject('OP-DETERMINACY', 'OBJECT_HASH_MISMATCH', 'The bytes are not the bytes that were hashed');
    const sent = await this.#call(params.tenantId, params.correlationId, 'PUT', params.objectKey, {
      body: params.bytes,
      payloadSha256Hex: params.sha256Hex,
      headers: { 'content-type': params.mediaType },
    });
    if (sent.kind !== 'RESPONSE') return sent.outcome;
    return ok({
      kind: 'ANSWERED',
      value: {
        objectKey: params.objectKey,
        sha256Hex: params.sha256Hex,
        byteLength: params.bytes.byteLength,
        mediaType: params.mediaType,
      },
    });
  }

  async get(params: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly sha256Hex: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly bytes: Uint8Array; readonly mediaType: StorableMediaType }>>> {
    if (!KEY_SHAPE.test(params.objectKey) || !params.objectKey.endsWith(params.sha256Hex))
      return reject('OP-DETERMINACY', 'OBJECT_KEY_INVALID', 'An object key ends in the hash of its bytes');
    const got = await this.#call(params.tenantId, params.correlationId, 'GET', params.objectKey, {
      payloadSha256Hex: EMPTY_PAYLOAD_SHA256,
      headers: {},
    });
    if (got.kind !== 'RESPONSE') return got.outcome;
    const bytes = new Uint8Array(await got.response.arrayBuffer());
    // Not the bytes that were stored: never served (SR-020).
    if (createHash('sha256').update(bytes).digest('hex') !== params.sha256Hex)
      return reject('OP-DETERMINACY', 'OBJECT_TAMPERED', 'The stored bytes do not match their recorded hash');
    const declared = (got.response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const mediaType = (STORABLE_MEDIA_TYPES as readonly string[]).includes(declared)
      ? (declared as StorableMediaType)
      : 'application/pdf';
    return ok({ kind: 'ANSWERED', value: { bytes, mediaType } });
  }

  async #call(
    tenantId: string,
    correlationId: string,
    method: 'GET' | 'PUT',
    objectKey: string,
    req: { readonly body?: Uint8Array; readonly payloadSha256Hex: string; readonly headers: Record<string, string> },
  ): Promise<
    | { readonly kind: 'RESPONSE'; readonly response: Response }
    | { readonly kind: 'OUTCOME'; readonly outcome: Result<never> | Result<RailOutcome<never>> }
  > {
    const read = async (keyName: string) =>
      (
        await this.credentials.get(
          { tenantId, provider: 'OBJECT_STORAGE', environment: this.options.environment, keyName },
          correlationId,
        )
      ).expose();
    let endpoint: string, region: string, bucket: string, accessKeyId: string, secretAccessKey: string;
    try {
      [endpoint, region, bucket, accessKeyId, secretAccessKey] = await Promise.all([
        read('endpoint'),
        read('region'),
        read('bucket'),
        read('access_key_id'),
        read('secret_access_key'),
      ]);
    } catch {
      // Which key is missing is the vault's audit record's business; the caller learns only that storage is not configured.
      return { kind: 'OUTCOME', outcome: unavailable('OBJECT_STORAGE_NOT_CONFIGURED') };
    }
    let url: URL;
    try {
      url = new URL(`${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}/${objectKey}`);
    } catch {
      return { kind: 'OUTCOME', outcome: unavailable('OBJECT_STORAGE_ENDPOINT_INVALID') };
    }
    if (url.protocol !== 'https:') return { kind: 'OUTCOME', outcome: unavailable('OBJECT_STORAGE_ENDPOINT_INVALID') };

    const headers = signRequest(
      { method, url, headers: req.headers, payloadSha256Hex: req.payloadSha256Hex },
      { accessKeyId, secretAccessKey, region },
      this.options.nowEpochSeconds(),
    );
    try {
      const response = await this.#breaker.execute(async () => {
        const r = await this.#fetch(url, {
          method,
          headers,
          ...(req.body === undefined ? {} : { body: new Uint8Array(req.body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
          redirect: 'error',
        });
        // A server-side failure counts against the circuit; a refusal does not.
        if (r.status >= 500) throw new StoreFailure(r.status);
        return r;
      });
      if (response.ok) return { kind: 'RESPONSE', response };
      await response.body?.cancel();
      return { kind: 'OUTCOME', outcome: refused(`HTTP_${response.status}`) };
    } catch (e) {
      if (e instanceof CircuitOpenError) return { kind: 'OUTCOME', outcome: unavailable('CIRCUIT_OPEN') };
      if (e instanceof StoreFailure) return { kind: 'OUTCOME', outcome: unavailable(`HTTP_${e.status}`) };
      return { kind: 'OUTCOME', outcome: unavailable('NETWORK') };
    }
  }
}

class StoreFailure extends Error {
  constructor(readonly status: number) {
    super(`object store answered ${status}`);
  }
}
