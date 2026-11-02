/**
 * The offer letter as a PDF: the HTML the engine prints (escaped, Arabic
 * first, self-contained, the letter version in the footer); the Nutrient
 * adapter (what it sends, what it refuses); and the service end to end — the
 * PDF fingerprinted, stored, recorded against the letter version, and read
 * back only by its own hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { offerLetterHtml } from '@sanad/core/documents/offer-letter-html.ts';
import { EnvironmentCredentialProvider } from '../../adapters/kernel/credentials-environment.ts';
import { NutrientPdfGeneration } from '../../adapters/nutrient/pdf-generation.ts';
import { listApplications, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import { readOfferPdf, renderOfferPdf } from '../../apps/ops/src/server/business-letter-pdf.ts';

const FAKE_PDF = new TextEncoder().encode('%PDF-1.7\n% rendered\n%%EOF\n');
const ENV = {
  SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_BASE_URL: 'http://127.0.0.1:5000',
  SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN: 'test-engine-token-not-real',
};

describe('the letter as HTML', () => {
  it('escapes, leads with Arabic, prints the version, and loads nothing from outside', async () => {
    resetBusinessStore();
    const letter = (await listApplications('sme-fund-ae')).find((v) => v.latestOffer !== undefined)?.latestOffer
      ?.letter;
    if (letter === undefined) throw new Error('no seeded letter');
    const html = offerLetterHtml({
      ...letter,
      productVariant: { en: '<script>alert(1)</script>', ar: letter.productVariant.ar },
    });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html.indexOf('lang="ar"', html.indexOf('<div class="cols">'))).toBeLessThan(
      html.indexOf('lang="en"', html.indexOf('<div class="cols">')),
    );
    expect(html).toContain(`letter version ${letter.version}`);
    expect(html).not.toMatch(/src=|href=|@import|url\(/);
  });
});

describe('the Nutrient adapter', () => {
  const engine = (
    respond: () => Response,
    env: Record<string, string> = ENV,
    seen: { url: string; auth: string | undefined }[] = [],
  ) =>
    new NutrientPdfGeneration(new EnvironmentCredentialProvider(() => undefined, env), {
      environment: 'sandbox',
      nowEpochSeconds: () => 1_800_000_000,
      fetchImpl: (async (url: URL | string, init?: RequestInit) => {
        seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)['authorization'] });
        return respond();
      }) as typeof fetch,
    });
  it('posts the page to /api/build with the token and returns the PDF', async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const r = expectOk(
      await engine(() => new Response(FAKE_PDF), ENV, seen).fromHtml({
        tenantId: 't',
        html: '<p>x</p>',
        correlationId: 'c',
      }),
    );
    expect(r.kind).toBe('ANSWERED');
    expect(seen[0]).toEqual({ url: 'http://127.0.0.1:5000/api/build', auth: 'Token token=test-engine-token-not-real' });
  });
  it('refuses what is not a PDF, keeps a 4xx apart from a 5xx, and never speaks plain http beyond loopback', async () => {
    const html = { tenantId: 't', html: '<p>x</p>', correlationId: 'c' };
    expect(expectOk(await engine(() => new Response('<html>error</html>')).fromHtml(html))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'DOCUMENT_ENGINE_MALFORMED',
    });
    expect(expectOk(await engine(() => new Response(null, { status: 401 })).fromHtml(html))).toEqual({
      kind: 'REFUSED',
      code: 'HTTP_401',
    });
    expect(expectOk(await engine(() => new Response(null, { status: 503 })).fromHtml(html))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'HTTP_503',
    });
    const remote = {
      ...ENV,
      SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_BASE_URL: 'http://engine.example',
    };
    expect(expectOk(await engine(() => new Response(FAKE_PDF), remote).fromHtml(html))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'DOCUMENT_ENGINE_URL_INVALID',
    });
    expect(expectOk(await engine(() => new Response(FAKE_PDF), {}).fromHtml(html))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'DOCUMENT_ENGINE_NOT_CONFIGURED',
    });
  });
});

describe('rendering through the service', () => {
  beforeEach(() => {
    vi.stubEnv('SANAD_DATABASE_URL', '');
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    vi.stubGlobal('fetch', async () => new Response(FAKE_PDF));
    resetBusinessStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('stores the PDF by its fingerprint against the letter version, and reads back only that hash', async () => {
    const app = (await listApplications('sme-fund-ae')).find((v) => v.latestOffer !== undefined);
    const id = app?.application.applicationId ?? '';
    const v = expectOk(await renderOfferPdf('sme-fund-ae', id, undefined, 'stf-ae-officer-01', 'c'));
    const pdf = v.letterPdfs.at(-1);
    expect(pdf).toMatchObject({
      letterVersion: app?.latestOffer?.letter.version,
      byteLength: FAKE_PDF.byteLength,
      storage: 'FIXTURE',
    });
    const read = await readOfferPdf('sme-fund-ae', id, pdf?.sha256Hex ?? '', 'c');
    expect(read.kind).toBe('BYTES');
    expect((await readOfferPdf('sme-fund-ae', id, 'f'.repeat(64), 'c')).kind).toBe('NOT_HELD');
    expect((await readOfferPdf('bank-a', id, pdf?.sha256Hex ?? '', 'c')).kind).toBe('NOT_HELD');
  });
});
