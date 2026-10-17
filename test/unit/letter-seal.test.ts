/**
 * Sealing the signed letter with the institution's digital signature: the
 * signed-revision cut (only the bytes the signature covers); the Nutrient
 * signing adapter (what it sends, what it refuses, that it never leaves its
 * copy on the engine); and the service end to end — only a signed letter,
 * only from a PDF of the signed version, only once, only a seal that
 * validated, and read back only by its own hash within its own tenant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { EnvironmentCredentialProvider } from '../../adapters/kernel/credentials-environment.ts';
import { NutrientDocumentSigning, signedRevision } from '../../adapters/nutrient/document-signing.ts';
import {
  SEED_PRINCIPALS,
  listApplications,
  recordSigned,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';
import { readOfferPdf, renderOfferPdf, sealSignedLetter } from '../../apps/ops/src/server/business-letter-pdf.ts';

const ENV = {
  SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_BASE_URL: 'http://127.0.0.1:5000',
  SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN: 'test-engine-token-not-real',
};
const TENANT = 'sme-fund-ae' as const;
const { officer } = SEED_PRINCIPALS;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
const enc = (s: string) => new TextEncoder().encode(s);

/** A signed revision whose /ByteRange ends exactly at its %%EOF, plus whatever is appended after it. */
function signedPdf(appended = ''): { readonly whole: Uint8Array; readonly revision: string } {
  const body = (d: number) =>
    `%PDF-1.7\n1 0 obj <</Type/Sig/ByteRange [0 10 20 ${String(d).padStart(6, '0')}]/Contents <00>>> endobj\n%%EOF\n`;
  const length = body(0).length;
  const revision = body(length - 20);
  return { whole: enc(revision + appended), revision };
}

const SIGNATURE = {
  PAdESSignatureLevel: 'b-b',
  signatureValidationStatus: 'valid',
  certificateChainValidationStatus: 'ok',
  documentIntegrityStatus: 'ok',
  ltv: false,
  signingCertificateChain: [
    { isCACertificate: false, subjectCommonName: 'Test Signer', issuerCommonName: 'Test CA', serialNumberHex: 'ED46' },
    { isCACertificate: true, subjectCommonName: 'Test CA', issuerCommonName: 'Test CA', serialNumberHex: 'DF5E' },
  ],
};

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: unknown;
}

/** A Document Engine double: build, upload, sign, rendition, delete. */
function engine(opts: { signStatus?: number; signature?: unknown; appended?: string } = {}) {
  const seen: Seen[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    seen.push({
      method,
      path: url.pathname,
      auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (url.pathname === '/api/build') return new Response(enc('%PDF-1.7\n% rendered\n%%EOF\n'));
    if (url.pathname === '/api/documents' && method === 'POST')
      return Response.json({ data: { document_id: 'DOC123' } });
    if (url.pathname === '/api/documents/DOC123/sign')
      return opts.signStatus === undefined
        ? Response.json({ data: { signature: opts.signature ?? SIGNATURE } })
        : new Response('no', { status: opts.signStatus });
    if (url.pathname === '/api/documents/DOC123/pdf') return new Response(signedPdf(opts.appended ?? '').whole);
    if (url.pathname === '/api/documents/DOC123' && method === 'DELETE') return new Response(null, { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { seen, impl };
}

describe('the signed revision', () => {
  it('is everything up to the end of the newest signature’s byte range, and nothing appended after it', () => {
    const { whole, revision } = signedPdf('% evaluation watermark update\n%%EOF\n');
    expect(new TextDecoder().decode(signedRevision(whole))).toBe(revision);
    expect(new TextDecoder().decode(signedRevision(enc(revision)))).toBe(revision);
  });
  it('is refused when there is no signature, the range runs past the file, or the cut misses the %%EOF', () => {
    expect(signedRevision(enc('%PDF-1.7\n%%EOF\n'))).toBeUndefined();
    expect(signedRevision(enc('%PDF-1.7 /ByteRange [0 10 20 999999] %%EOF\n'))).toBeUndefined();
    const { revision } = signedPdf();
    expect(signedRevision(enc(revision.replace('%%EOF', '%%XXX')))).toBeUndefined();
  });
});

describe('the Nutrient signing adapter', () => {
  const adapter = (impl: typeof fetch, env: Record<string, string> = ENV) =>
    new NutrientDocumentSigning(new EnvironmentCredentialProvider(() => undefined, env), {
      environment: 'sandbox',
      nowEpochSeconds: () => 1_800_000_000,
      fetchImpl: impl,
    });
  const seal = (impl: typeof fetch, env?: Record<string, string>) =>
    adapter(impl, env).sealPdf({
      tenantId: 't',
      pdf: enc('%PDF-1.7\n'),
      signingToken: '{"purpose":"X"}',
      correlationId: 'c',
    });

  it('uploads, signs RAW CAdES with the token, returns the signed revision and its validation, and deletes its copy', async () => {
    const e = engine({ appended: '% appended\n%%EOF\n' });
    const r = expectOk(await seal(e.impl));
    if (r.kind !== 'ANSWERED') throw new Error(r.kind);
    expect(new TextDecoder().decode(r.value.bytes)).toBe(signedPdf().revision);
    expect(r.value.validation).toEqual({
      padesLevel: 'b-b',
      signatureValid: true,
      chainValid: true,
      integrityValid: true,
      longTermValidation: false,
      signerCommonName: 'Test Signer',
      issuerCommonName: 'Test CA',
      certificateSerialHex: 'ED46',
    });
    expect(e.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /api/documents',
      'POST /api/documents/DOC123/sign',
      'GET /api/documents/DOC123/pdf',
      'DELETE /api/documents/DOC123',
    ]);
    expect(e.seen[1]?.body).toEqual({
      signatureContainer: 'raw',
      signatureType: 'cades',
      cadesLevel: 'b-b',
      signingToken: '{"purpose":"X"}',
    });
    expect(e.seen.every((s) => s.auth === 'Token token=test-engine-token-not-real')).toBe(true);
  });

  it('a refused signing is REFUSED, and the engine’s copy is still deleted', async () => {
    const e = engine({ signStatus: 422 });
    expect(expectOk(await seal(e.impl))).toEqual({ kind: 'REFUSED', code: 'HTTP_422' });
    expect(e.seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/documents/DOC123' });
  });

  it('an outage, an unreadable answer or a missing configuration is UNAVAILABLE', async () => {
    expect(expectOk(await seal(engine({ signStatus: 503 }).impl))).toEqual({ kind: 'UNAVAILABLE', reason: 'HTTP_503' });
    expect(expectOk(await seal(engine({ signature: { signingCertificateChain: [] } }).impl))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'DOCUMENT_ENGINE_MALFORMED',
    });
    expect(expectOk(await seal(engine().impl, {}))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'DOCUMENT_ENGINE_NOT_CONFIGURED',
    });
    expect(
      expectOk(
        await seal(engine().impl, {
          ...ENV,
          SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_BASE_URL: 'http://engine.example.com',
        }),
      ),
    ).toEqual({ kind: 'UNAVAILABLE', reason: 'DOCUMENT_ENGINE_URL_INVALID' });
  });
});

describe('sealing through the service', () => {
  const setEngine = (opts?: Parameters<typeof engine>[0]) => vi.stubGlobal('fetch', engine(opts).impl);
  beforeEach(() => {
    vi.stubEnv('SANAD_DATABASE_URL', '');
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    setEngine();
    resetBusinessStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const sent = async () => {
    const v = (await listApplications(TENANT)).find((x) => x.application.status === 'OFFER_SENT');
    if (v === undefined) throw new Error('no seed in OFFER_SENT');
    return v;
  };

  it('seals only a signed letter, only from a PDF of the signed version, and only once', async () => {
    const v = await sent();
    const id = v.application.applicationId;
    const version = v.application.offer?.letterVersion ?? '';
    expect(reason(await sealSignedLetter(TENANT, id, officer, 'c'))).toBe('LETTER_NOT_SIGNED');
    expectOk(await recordSigned(TENANT, id, { letterVersion: version }, officer));
    expect(reason(await sealSignedLetter(TENANT, id, officer, 'c'))).toBe('LETTER_PDF_NOT_RENDERED');
    const rendered = expectOk(await renderOfferPdf(TENANT, id, version, officer, 'c'));
    const pdf = rendered.letterPdfs.at(-1);

    const sealed = expectOk(await sealSignedLetter(TENANT, id, officer, 'c'));
    expect(sealed.sealedLetters).toHaveLength(1);
    expect(sealed.sealedLetters[0]).toMatchObject({
      letterVersion: version,
      sourceSha256Hex: pdf?.sha256Hex,
      signatureRef: sealed.application.signature?.signatureRef,
      padesLevel: 'b-b',
      longTermValidation: false,
      signerCommonName: 'Test Signer',
      environment: 'sandbox',
      sealedBy: officer,
    });
    expect(sealed.events.some((e) => e.eventType === 'LETTER_SEALED')).toBe(true);
    expect(reason(await sealSignedLetter(TENANT, id, officer, 'c'))).toBe('LETTER_ALREADY_SEALED');

    const hash = sealed.sealedLetters[0]?.sha256Hex ?? '';
    expect((await readOfferPdf(TENANT, id, hash, 'c')).kind).toBe('BYTES');
    expect((await readOfferPdf('bank-a', id, hash, 'c')).kind).toBe('NOT_HELD');
  });

  it('a seal that does not validate is neither stored nor recorded', async () => {
    const v = await sent();
    const id = v.application.applicationId;
    const version = v.application.offer?.letterVersion ?? '';
    expectOk(await recordSigned(TENANT, id, { letterVersion: version }, officer));
    expectOk(await renderOfferPdf(TENANT, id, version, officer, 'c'));
    for (const broken of [
      { signatureValidationStatus: 'invalid' },
      { certificateChainValidationStatus: 'failed' },
      { documentIntegrityStatus: 'tampered' },
    ]) {
      setEngine({ signature: { ...SIGNATURE, ...broken } });
      expect(reason(await sealSignedLetter(TENANT, id, officer, 'c'))).toBe('SEAL_NOT_VALID');
    }
    const after = (await listApplications(TENANT)).find((x) => x.application.applicationId === id);
    expect(after?.sealedLetters).toEqual([]);
    expect(after?.events.some((e) => e.eventType === 'LETTER_SEALED')).toBe(false);
  });

  it('an engine that does not answer seals nothing', async () => {
    const v = await sent();
    const id = v.application.applicationId;
    const version = v.application.offer?.letterVersion ?? '';
    expectOk(await recordSigned(TENANT, id, { letterVersion: version }, officer));
    expectOk(await renderOfferPdf(TENANT, id, version, officer, 'c'));
    setEngine({ signStatus: 503 });
    expect(reason(await sealSignedLetter(TENANT, id, officer, 'c'))).toBe('DOCUMENT_SIGNING_UNAVAILABLE');
  });
});
