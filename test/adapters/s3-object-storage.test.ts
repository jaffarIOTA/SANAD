/**
 * The S3-compatible object store adapter, against a recorded-shape fake
 * store: path-style addressing, a signed request, the store's error body
 * never read, a refusal kept apart from an outage, and bytes that do not
 * hash to their record refused rather than served.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { EnvironmentCredentialProvider } from '../../adapters/kernel/credentials-environment.ts';
import { S3ObjectStorage } from '../../adapters/storage/s3/adapter.ts';
import { InMemoryObjectStorage } from '../../adapters/storage/memory.ts';

const SECRET = 'test-secret-access-key-not-a-credential';
const env = {
  SANAD_CREDENTIAL_OBJECT_STORAGE_SANDBOX_ENDPOINT: 'https://store.example/storage/v1/s3',
  SANAD_CREDENTIAL_OBJECT_STORAGE_SANDBOX_REGION: 'ap-south-1',
  SANAD_CREDENTIAL_OBJECT_STORAGE_SANDBOX_BUCKET: 'documents',
  SANAD_CREDENTIAL_OBJECT_STORAGE_SANDBOX_ACCESS_KEY_ID: 'synthetic-access-key',
  SANAD_CREDENTIAL_OBJECT_STORAGE_SANDBOX_SECRET_ACCESS_KEY: SECRET,
};
const pdf = new TextEncoder().encode('%PDF-1.7 synthetic');
const sha = createHash('sha256').update(pdf).digest('hex');
const key = `sme-fund-ae/business/FR-00005101/${sha}`;

interface Seen {
  url: string;
  init: RequestInit;
}
const store = (respond: (seen: Seen) => Response | Promise<Response>, credentials = env) => {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const s = { url: String(url), init: init ?? {} };
    seen.push(s);
    return respond(s);
  }) as typeof fetch;
  const adapter = new S3ObjectStorage(new EnvironmentCredentialProvider(() => undefined, credentials), {
    environment: 'sandbox',
    nowEpochSeconds: () => 1_800_000_000,
    fetchImpl,
  });
  return { adapter, seen };
};
const put = (adapter: S3ObjectStorage) =>
  adapter.put({ tenantId: 'sme-fund-ae', objectKey: key, bytes: pdf, mediaType: 'application/pdf', sha256Hex: sha, correlationId: 'c' });

describe('the S3 object store adapter', () => {
  it('puts path-style, signed, with the content type and the payload hash', async () => {
    const { adapter, seen } = store(() => new Response(null, { status: 200 }));
    const r = expectOk(await put(adapter));
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { objectKey: key, sha256Hex: sha, byteLength: pdf.byteLength, mediaType: 'application/pdf' },
    });
    expect(seen[0]?.url).toBe(`https://store.example/storage/v1/s3/documents/${key}`);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['x-amz-content-sha256']).toBe(sha);
    expect(headers['content-type']).toBe('application/pdf');
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=synthetic-access-key\/\d{8}\/ap-south-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  it('keeps a refusal (4xx) apart from an outage (5xx, network), and never reads the store’s body', async () => {
    const refused = store(() => new Response('<Error>AccessDenied for synthetic-access-key</Error>', { status: 403 }));
    expect(expectOk(await put(refused.adapter))).toEqual({ kind: 'REFUSED', code: 'HTTP_403' });
    const down = store(() => new Response('boom', { status: 503 }));
    expect(expectOk(await put(down.adapter))).toEqual({ kind: 'UNAVAILABLE', reason: 'HTTP_503' });
    const network = store(() => {
      throw new TypeError('fetch failed');
    });
    expect(expectOk(await put(network.adapter))).toEqual({ kind: 'UNAVAILABLE', reason: 'NETWORK' });
  });

  it('opens the circuit after repeated outages and stops calling', async () => {
    const { adapter, seen } = store(() => new Response(null, { status: 500 }));
    for (let i = 0; i < 5; i++) await put(adapter);
    expect(expectOk(await put(adapter))).toEqual({ kind: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' });
    expect(seen).toHaveLength(5);
  });

  it('is unavailable, not failing open, when the vault holds no store for the tenant', async () => {
    const { adapter, seen } = store(() => new Response(null, { status: 200 }), {} as typeof env);
    expect(expectOk(await put(adapter))).toEqual({ kind: 'UNAVAILABLE', reason: 'OBJECT_STORAGE_NOT_CONFIGURED' });
    expect(seen).toHaveLength(0);
  });

  it('refuses a plain-http endpoint before sending anything', async () => {
    const { adapter, seen } = store(() => new Response(null, { status: 200 }), {
      ...env,
      SANAD_CREDENTIAL_OBJECT_STORAGE_SANDBOX_ENDPOINT: 'http://store.example/s3',
    });
    expect(expectOk(await put(adapter))).toEqual({ kind: 'UNAVAILABLE', reason: 'OBJECT_STORAGE_ENDPOINT_INVALID' });
    expect(seen).toHaveLength(0);
  });

  it('refuses bytes that are not the bytes hashed, and a key that does not end in the hash', async () => {
    const { adapter, seen } = store(() => new Response(null, { status: 200 }));
    const wrong = await adapter.put({
      tenantId: 'sme-fund-ae', objectKey: key, bytes: new TextEncoder().encode('%PDF-other'),
      mediaType: 'application/pdf', sha256Hex: sha, correlationId: 'c',
    });
    expect(wrong.ok ? 'stored' : wrong.error.reason).toBe('OBJECT_HASH_MISMATCH');
    const badKey = await adapter.put({
      tenantId: 'sme-fund-ae', objectKey: 'sme-fund-ae/business/FR-1/report.pdf', bytes: pdf,
      mediaType: 'application/pdf', sha256Hex: sha, correlationId: 'c',
    });
    expect(badKey.ok ? 'stored' : badKey.error.reason).toBe('OBJECT_KEY_INVALID');
    expect(seen).toHaveLength(0);
  });

  it('reads bytes back only when they hash to the record', async () => {
    const good = store(() => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const r = expectOk(await good.adapter.get({ tenantId: 'sme-fund-ae', objectKey: key, sha256Hex: sha, correlationId: 'c' }));
    expect(r.kind === 'ANSWERED' ? Buffer.from(r.value.bytes).toString() : r.kind).toBe('%PDF-1.7 synthetic');
    const tampered = store(() => new Response('%PDF-swapped', { status: 200 }));
    const t = await tampered.adapter.get({ tenantId: 'sme-fund-ae', objectKey: key, sha256Hex: sha, correlationId: 'c' });
    expect(t.ok ? 'served' : t.error.reason).toBe('OBJECT_TAMPERED');
  });
});

describe('the in-memory fixture store', () => {
  it('is labelled FIXTURE and keeps one tenant’s object from another', async () => {
    const memory = new InMemoryObjectStorage();
    expect(memory.source).toBe('FIXTURE');
    expectOk(await memory.put({ tenantId: 'a', objectKey: key, bytes: pdf, mediaType: 'application/pdf', sha256Hex: sha }));
    expect(expectOk(await memory.get({ tenantId: 'b', objectKey: key, sha256Hex: sha }))).toEqual({
      kind: 'REFUSED',
      code: 'NOT_HELD',
    });
    expect(expectOk(await memory.get({ tenantId: 'a', objectKey: key, sha256Hex: sha })).kind).toBe('ANSWERED');
  });
});
