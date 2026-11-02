/**
 * The offer letter as a PDF: the HTML the engine prints (escaped, Arabic
 * first, self-contained, the letter version in the footer); the Nutrient
 * adapter (what it sends, what it refuses); and the service end to end — the
 * PDF fingerprinted, stored, recorded against the letter version, and read
 * back only by its own hash.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { offerLetterHtml, safeLetterSvg } from '@sanad/core/documents/offer-letter-html.ts';
import { loadLetterBranding } from '@sanad/config/loader.ts';
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
    expect(html).toContain(`letter version ${letter.version}`);
    expect(html).not.toMatch(/src=|href=|@import|url\(/);
  });

  it('pairs every item in one row, Arabic first, so a line and its translation start level', async () => {
    resetBusinessStore();
    const letter = (await listApplications('sme-fund-ae')).find((v) => v.latestOffer !== undefined)?.latestOffer
      ?.letter;
    if (letter === undefined) throw new Error('no seeded letter');
    const html = offerLetterHtml(letter);
    const rows = [...html.matchAll(/<tr class="([a-z]+)">(.*?)<\/tr>/gs)];
    // Title, two meta lines, three parties, four headings, each term, each repayment line, each condition,
    // the validity, each signature.
    expect(rows).toHaveLength(
      1 +
        2 +
        3 +
        4 +
        letter.terms.length +
        letter.repayment.length +
        letter.conditions.length +
        1 +
        letter.signatures.length,
    );
    for (const [, , cells] of rows)
      expect(cells).toMatch(/^<td lang="ar" dir="rtl">.*<\/td><td lang="en" dir="ltr">.*<\/td>$/s);
    const signature = rows.filter(([, cls]) => cls === 'signature').map(([, , cells]) => cells ?? '');
    expect(signature[0]).toContain(letter.signatures[0]?.partyName.ar);
    expect(signature[0]).toContain(letter.signatures[0]?.partyName.en);
    // Arabic conditions are numbered in Arabic-Indic digits, English ones in Latin.
    expect(html).toContain('<span class="n">١.</span>');
    expect(html).toContain('<span class="n">1.</span>');
  });

  it('embeds the typeface only as WOFF2 data, and leaves out a face that is not well formed', async () => {
    resetBusinessStore();
    const letter = (await listApplications('sme-fund-ae')).find((v) => v.latestOffer !== undefined)?.latestOffer
      ?.letter;
    if (letter === undefined) throw new Error('no seeded letter');
    const html = offerLetterHtml(letter, undefined, [
      { weight: 400, unicodeRange: 'U+0600-06FF, U+FB50-FDFF', woff2Base64: 'd09GMgABAAA=' },
      { weight: 700, unicodeRange: 'U+0000-00FF; } body { display: none', woff2Base64: 'd09GMgABAAA=' },
      { weight: 600, unicodeRange: 'U+0000-00FF', woff2Base64: 'x) ; @import url(https://x.example/a.css' },
    ]);
    expect(html.match(/@font-face/g)).toHaveLength(1);
    expect(html).toContain(
      "src: url(data:font/woff2;base64,d09GMgABAAA=) format('woff2'); unicode-range: U+0600-06FF, U+FB50-FDFF;",
    );
    expect(html).not.toContain('display: none');
    expect(html).not.toMatch(/src=|href=|@import|url\((?!data:font\/woff2;base64,)/);
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

  it('prints the interim letterhead where a synthetic demonstration is permitted', async () => {
    let html = '';
    vi.stubGlobal('fetch', async (_url: URL | string, init?: RequestInit) => {
      html = await ((init?.body as FormData).get('page') as Blob).text();
      return new Response(FAKE_PDF);
    });
    const id = (await listApplications('sme-fund-ae')).find((v) => v.latestOffer !== undefined)?.application
      .applicationId;
    expectOk(await renderOfferPdf('sme-fund-ae', id ?? '', undefined, 'stf-ae-officer-01', 'c'));
    expect(html).toContain('<header class="letterhead">');
    expect(html).toContain('aria-label="Sanad"');
    expect(html).toContain('aria-label="سند"');
    // The platform's one typeface, embedded: three weights, each split by script.
    expect(html.match(/@font-face \{ font-family: 'Sanad Letter'/g)).toHaveLength(6);
  });

  it('prints no interim letterhead where a synthetic demonstration is not permitted', async () => {
    let html = '';
    vi.stubGlobal('fetch', async (_url: URL | string, init?: RequestInit) => {
      html = await ((init?.body as FormData).get('page') as Blob).text();
      return new Response(FAKE_PDF);
    });
    // The illustrative book is seeded under development; the render then runs as if deployed.
    const id = (await listApplications('sme-fund-ae')).find((v) => v.latestOffer !== undefined)?.application
      .applicationId;
    vi.stubEnv('SANAD_DEPLOYMENT_PROFILE', 'DEPLOYED');
    // The render itself may then stop at storage (no development store when deployed); the page sent is what matters.
    await renderOfferPdf('sme-fund-ae', id ?? '', undefined, 'stf-ae-officer-01', 'c');
    expect(html).toContain('Facility Offer Letter');
    expect(html).not.toContain('letterhead">');
    expect(html).not.toContain('aria-label="Sanad"');
  });
});

describe('the letterhead', () => {
  const letter = async () => {
    resetBusinessStore();
    const l = (await listApplications('sme-fund-ae')).find((v) => v.latestOffer !== undefined)?.latestOffer?.letter;
    if (l === undefined) throw new Error('no seeded letter');
    return l;
  };

  it('is configured for every tenant, on the interim mark, and prints both lockups in the brand colours', async () => {
    for (const t of ['sme-fund-ae', 'bank-a', 'fintech-b'] as const) {
      const b = expectOk(loadLetterBranding(t));
      expect(b?.markStatus).toBe('INTERIM_SYNTHETIC_ONLY');
      expect(safeLetterSvg(b?.branding.logoEnSvg ?? '')).toBeDefined();
      expect(safeLetterSvg(b?.branding.logoArSvg ?? '')).toBeDefined();
    }
    const branding = expectOk(loadLetterBranding('sme-fund-ae'))?.branding;
    const html = offerLetterHtml(await letter(), branding);
    expect(html.indexOf('lang="ar"><svg')).toBeLessThan(html.indexOf('lang="en"><svg'));
    expect(html).toContain('border-bottom: 0.6mm solid #2D60FF');
    expect(html).toContain('h1, h2 { color: #343C6A; }');
    expect(html).not.toMatch(/src=|href=|@import|url\(/);
  });

  it('is left out, whole or in part, when a logo is not plain shapes or a colour is not a colour', async () => {
    const l = await letter();
    const ok =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>X</title><path fill="#000" d="M0 0H10V10Z"/></svg>';
    expect(safeLetterSvg(ok)).toBe(ok);
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"><path d="M0 0"/></svg>',
      '<svg><image href="https://x.example/a.png"/></svg>',
      '<svg><a href="https://x.example"><path d="M0 0"/></a></svg>',
      '<svg><style>path{fill:url(https://x.example)}</style></svg>',
      '<svg><path d="M0 0" style="fill:red"/></svg>',
      '<svg><!-- --><path d="M0 0"/></svg>',
      '<svg><path d="&amp;"/></svg>',
      '<svg>loose text<path d="M0 0"/></svg>',
      '<div><svg></svg></div>',
    ])
      expect(safeLetterSvg(bad), bad).toBeUndefined();
    const html = offerLetterHtml(l, {
      logoEnSvg: '<svg onload="x()"></svg>',
      logoArSvg: '<svg><script/></svg>',
      accent: 'red; } body { display: none',
      heading: '#343C6A',
    });
    expect(html).not.toContain('<header class="letterhead">');
    expect(html).not.toContain('display: none');
    expect(html).toContain('solid #444444');
    expect(offerLetterHtml(l)).not.toContain('letterhead">');
  });
});
