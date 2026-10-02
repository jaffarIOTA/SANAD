/**
 * The viewer token names one document, carries its permissions and an expiry
 * a few minutes out, and verifies against the public half of the key. The
 * engine's API token is nowhere in it (V-07).
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DOCUMENT_ENGINE_ROUTES, DocumentEngineTransport } from '../../adapters/nutrient/live-transport.ts';
import { VIEWER_TOKEN_MAX_TTL_SECONDS, issueViewerToken } from '../../adapters/nutrient/viewer-token.ts';
import type { HttpTransport, RailEnvelope } from '../../adapters/kernel/http-transport.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('the viewer token', () => {
  it('is RS256-signed over one document with permissions and a bounded expiry', () => {
    const token = issueViewerToken({ documentId: 'doc-1', permissions: ['read-document', 'download'], layer: 'app-77', nowEpochSeconds: 1_800_000_000n }, privateKey);
    const [h, p, s] = token.split('.') as [string, string, string];
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(p)).toEqual({ document_id: 'doc-1', permissions: ['read-document', 'download'], layer: 'app-77', iat: 1_800_000_000, exp: 1_800_000_300 });
    const v = createVerify('RSA-SHA256'); v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
  it('refuses a ttl beyond the ceiling, an empty document or no permissions', () => {
    const base = { documentId: 'doc-1', permissions: ['read-document' as const], nowEpochSeconds: 1n };
    expect(() => issueViewerToken({ ...base, ttlSeconds: VIEWER_TOKEN_MAX_TTL_SECONDS + 1n }, privateKey)).toThrow();
    expect(() => issueViewerToken({ ...base, documentId: ' ' }, privateKey)).toThrow();
    expect(() => issueViewerToken({ ...base, permissions: [] }, privateKey)).toThrow();
  });
});

describe('the document engine transport', () => {
  const calls: { operation: string; envelope: RailEnvelope }[] = [];
  const http = { call: (operation: string, envelope: RailEnvelope) => { calls.push({ operation, envelope }); return Promise.resolve({}); } } as unknown as HttpTransport;
  it('builds the envelope from the route table against the configured host, carrying the adapter headers untouched', async () => {
    const t = new DocumentEngineTransport(http, 'http://127.0.0.1:5000');
    await t.call('signature.validate', { documentId: 'doc 1' }, { Authorization: 'Token token=x' });
    expect(calls[0]?.envelope).toEqual({ method: 'GET', url: 'http://127.0.0.1:5000/api/documents/doc%201/digital_signatures', headers: { Authorization: 'Token token=x' } });
    await t.call('signature.padesLtv', { documentId: 'd', contentHash: 'h', identityAssertionId: 'asr-1', requestTimestamp: true }, {});
    expect(calls[1]?.envelope.method).toBe('POST'); expect(JSON.stringify(calls[1]?.envelope.body)).toContain('b-lt');
  });
  it('refuses a base URL with a path or trailing slash, and every operation has a route with a verification item', () => {
    expect(() => new DocumentEngineTransport(http, 'http://host/api/')).toThrow();
    for (const route of Object.values(DOCUMENT_ENGINE_ROUTES)) expect(route.verification).toMatch(/^V-0[2-8]$/);
  });
});
