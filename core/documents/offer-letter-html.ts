/**
 * The Facility Offer Letter as one self-contained HTML page, ready for a PDF
 * engine to print on A4 (through core/ports/pdf-generation.ts).
 *
 * Pure. It renders exactly the letter's content — the same figures the
 * screen previews and the customer signs, nothing computed here — Arabic
 * (the governing text, right to left) and English side by side, with the
 * letter's version (the SHA-256 of its content) closing the letter so the
 * paper and the record can be matched. Every string is escaped; the page
 * loads nothing from outside (no image, no script, no font service), so the
 * engine needs no network and nothing can be injected into the document.
 *
 * Laid out as one bilingual table, not two columns: each item — the title,
 * each term, each condition, each signature — is one row, the Arabic on the
 * right and the English on the left, so a line and its translation always
 * start level, however much longer one of them runs. A row is never split
 * across pages.
 *
 * The typeface is the platform's one family for both scripts, embedded in
 * the page (data URIs) by the caller, so the PDF is set exactly as the
 * screens are, whatever fonts the engine's host has.
 */
import { type BilingualText, type OfferLetter, arabicIndic } from './offer-letter.ts';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LABELS: Readonly<Record<string, BilingualText>> = {
  lender: { en: 'Lender', ar: 'المُقرض' },
  borrower: { en: 'Borrower', ar: 'المقترض' },
  product: { en: 'Product', ar: 'المنتج' },
  terms: { en: 'Facility terms', ar: 'شروط التمويل' },
  repayment: { en: 'Repayment', ar: 'ملخص السداد' },
  conditions: { en: 'Conditions', ar: 'الشروط' },
  signatures: { en: 'Signatures', ar: 'التوقيعات' },
  offerDate: { en: 'Offer date', ar: 'تاريخ العرض' },
  validUntil: { en: 'Valid until', ar: 'ساري حتى' },
  signHere: { en: 'Signature and date', ar: 'التوقيع والتاريخ' },
};
const label = (k: string): BilingualText => LABELS[k] ?? { en: k, ar: k };

/** One bilingual row: the same item in each language, given as markup per language (already escaped). */
const row = (cls: string, cell: (lang: 'ar' | 'en') => string): string =>
  `<tr class="${cls}"><td lang="ar" dir="rtl">${cell('ar')}</td><td lang="en" dir="ltr">${cell('en')}</td></tr>`;

function body(letter: OfferLetter): string {
  const t = (b: BilingualText, lang: 'ar' | 'en') => escapeHtml(b[lang]);
  const date = (d: OfferLetter['offerDate'], lang: 'ar' | 'en') =>
    `${t(d.gregorian, lang)}${d.hijri === undefined ? '' : ` <span class="hijri">(${escapeHtml(d.hijri)})</span>`}`;
  const kv = (k: BilingualText, v: BilingualText) =>
    row('kv', (l) => `<span class="k">${t(k, l)}</span><span class="v">${t(v, l)}</span>`);
  const heading = (k: string) => row('section', (l) => `<h2>${t(label(k), l)}</h2>`);
  const ordinal = (i: number, lang: 'ar' | 'en') => (lang === 'ar' ? arabicIndic(String(i + 1)) : String(i + 1));
  return [
    row('title', (l) => `<h1>${t(letter.title, l)}</h1>`),
    row('meta', (l) => `${escapeHtml(letter.reference)} · ${t(label('offerDate'), l)}: ${date(letter.offerDate, l)}`),
    kv(label('lender'), letter.parties.lender),
    kv(label('borrower'), letter.parties.borrower),
    kv(label('product'), letter.productVariant),
    heading('terms'),
    ...letter.terms.map((r) => kv(r.label, r.value)),
    heading('repayment'),
    ...letter.repayment.map((r) => kv(r.label, r.value)),
    heading('conditions'),
    ...letter.conditions.map((c, i) =>
      row('condition', (l) => `<span class="n">${ordinal(i, l)}.</span><span class="c">${t(c, l)}</span>`),
    ),
    row('validity', (l) => t(letter.validity, l)),
    row('meta', (l) => `${t(label('validUntil'), l)}: ${date(letter.validUntil, l)}`),
    heading('signatures'),
    ...letter.signatures.map((s) =>
      row(
        'signature',
        (l) =>
          `<p class="party">${t(s.partyName, l)}</p><p class="role">${t(s.role, l)}</p><p class="line">${t(label('signHere'), l)}</p>`,
      ),
    ),
  ].join('\n');
}

/**
 * The letterhead: the issuing institution's logo in each script and its two
 * colours. Configuration (config/tenants/<t>/documents/letter-branding.json);
 * which brand may appear on a letter, and where, is the caller's decision.
 */
export interface LetterBranding {
  /** Inline SVG markup of the Latin lockup. */
  readonly logoEnSvg: string;
  /** Inline SVG markup of the Arabic lockup. */
  readonly logoArSvg: string;
  /** #rrggbb: the rule under the letterhead and the footer. */
  readonly accent: string;
  /** #rrggbb: headings. */
  readonly heading: string;
}

/** One face of the letter's typeface, embedded: a weight, the characters it covers, the WOFF2 bytes as Base64. */
export interface LetterFontFace {
  readonly weight: 400 | 500 | 600 | 700;
  /** A CSS unicode-range, e.g. "U+0600-06FF, U+FB50-FDFF". */
  readonly unicodeRange: string;
  readonly woff2Base64: string;
}

const LETTER_FAMILY = 'Sanad Letter';
const UNICODE_RANGE = /^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:,\s*U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** @font-face rules for the faces that are well formed; a face that is not is left out, never interpolated. */
function fontFaces(faces: readonly LetterFontFace[]): string {
  return faces
    .filter(
      (f) =>
        [400, 500, 600, 700].includes(f.weight) &&
        UNICODE_RANGE.test(f.unicodeRange) &&
        f.woff2Base64.length > 0 &&
        f.woff2Base64.length <= 2 * 1024 * 1024 &&
        BASE64.test(f.woff2Base64),
    )
    .map(
      (f) =>
        `@font-face { font-family: '${LETTER_FAMILY}'; font-style: normal; font-weight: ${f.weight}; src: url(data:font/woff2;base64,${f.woff2Base64}) format('woff2'); unicode-range: ${f.unicodeRange}; }`,
    )
    .join('\n');
}

const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'title']);
const SVG_ATTRIBUTES = new Set(['xmlns', 'viewBox', 'role', 'aria-label', 'fill', 'transform', 'd']);
const COLOUR = /^#[0-9A-Fa-f]{6}$/;

/**
 * An SVG fit to print inline, or undefined. Only shapes: the elements svg, g,
 * path and title, and the attributes that draw them. No script, style, link,
 * image, entity or event handler can pass, so the page still loads nothing and
 * runs nothing.
 */
export function safeLetterSvg(svg: string): string | undefined {
  const s = svg.trim();
  if (s.length === 0 || s.length > 64 * 1024 || !s.startsWith('<svg') || !s.endsWith('</svg>')) return undefined;
  // One linear pass, no backtracking: tags, their attributes, and the text between them.
  let i = 0;
  let inTitle = false;
  while (i < s.length) {
    const open = s.indexOf('<', i);
    const text = s.slice(i, open < 0 ? s.length : open);
    // Text is only a title's, and never an entity.
    if (text.includes('&') || text.includes('>') || (!inTitle && text.trim().length > 0)) return undefined;
    if (open < 0) break;
    const close = s.indexOf('>', open);
    if (close < 0) return undefined;
    const tag = s.slice(open + 1, close);
    if (tag.includes('<')) return undefined;
    const closing = tag.startsWith('/');
    const tagBody = (closing ? tag.slice(1) : tag).replace(/\/$/, '');
    const nameEnd = tagBody.search(/\s|$/);
    const name = tagBody.slice(0, nameEnd);
    if (!SVG_ELEMENTS.has(name)) return undefined;
    let rest = tagBody.slice(nameEnd);
    if (closing && rest.trim().length > 0) return undefined;
    while (rest.trim().length > 0) {
      rest = rest.trimStart();
      const eq = rest.indexOf('="');
      if (eq <= 0) return undefined;
      const attr = rest.slice(0, eq);
      const end = rest.indexOf('"', eq + 2);
      if (end < 0 || !SVG_ATTRIBUTES.has(attr) || rest.slice(eq + 2, end).includes('&')) return undefined;
      rest = rest.slice(end + 1);
      if (rest.length > 0 && !/^\s/.test(rest)) return undefined;
    }
    if (name === 'title') inTitle = !closing && !tag.endsWith('/');
    i = close + 1;
  }
  return s;
}

function letterhead(branding: LetterBranding | undefined): { readonly html: string; readonly css: string } {
  if (branding === undefined) return { html: '', css: '' };
  const en = safeLetterSvg(branding.logoEnSvg);
  const ar = safeLetterSvg(branding.logoArSvg);
  const accent = COLOUR.test(branding.accent) ? branding.accent : '#444444';
  const heading = COLOUR.test(branding.heading) ? branding.heading : '#111111';
  // Right to left: the Arabic lockup sits on the reading side, the Latin one opposite.
  const html =
    en === undefined && ar === undefined
      ? ''
      : `<header class="letterhead"><div class="logo" lang="ar">${ar ?? ''}</div><div class="logo" lang="en">${en ?? ''}</div></header>`;
  const css = `
  .letterhead { display: flex; justify-content: space-between; align-items: center; padding-bottom: 3mm; margin-bottom: 6mm; border-bottom: 0.6mm solid ${accent}; }
  .letterhead .logo svg { height: 11mm; width: auto; display: block; }
  h1, h2 { color: ${heading}; }
  .footer { border-top: 0.3mm solid ${accent}; }`;
  return { html, css };
}

/** The letter as HTML: the letterhead when branded, then one bilingual row per item; the version closes it. */
export function offerLetterHtml(
  letter: OfferLetter,
  branding?: LetterBranding,
  fonts: readonly LetterFontFace[] = [],
): string {
  const version = escapeHtml(letter.version);
  const head = letterhead(branding);
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(letter.title.en)} — ${escapeHtml(letter.reference)}</title>
<style>
  ${fontFaces(fonts)}
  @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
  body { font-family: '${LETTER_FAMILY}', 'IBM Plex Sans Arabic', sans-serif; font-size: 10pt; line-height: 1.45; color: #1d2233; margin: 0; font-variant-numeric: tabular-nums; }
  h1 { font-size: 16pt; font-weight: 700; margin: 0; line-height: 1.25; }
  h2 { font-size: 9.5pt; font-weight: 700; margin: 0; letter-spacing: 0.02em; color: #444; }
  td[lang='en'] h2 { text-transform: uppercase; }${head.css}
  /* The two languages share every row; 8mm between them, none between rows. */
  /* border-spacing also pads the outer edges; the negative margin takes that back so the text meets the margins. */
  table.bilingual { table-layout: fixed; border-collapse: separate; border-spacing: 8mm 0; margin: 0 -8mm; width: calc(100% + 16mm); }
  table.bilingual td { width: 50%; vertical-align: top; text-align: start; padding: 1.4mm 0; }
  table.bilingual tr { break-inside: avoid; }
  tr.title td { padding-bottom: 1mm; }
  tr.meta td { color: #4f6a99; font-size: 8.5pt; padding: 0.6mm 0 2.5mm; }
  tr.section td { padding-top: 5mm; padding-bottom: 1.2mm; border-bottom: 0.3mm solid #cfd5e3; }
  tr.kv td { border-bottom: 0.2mm solid #e3e7ef; }
  .k { display: inline-block; width: 46%; color: #4f6a99; vertical-align: top; padding-inline-end: 2mm; box-sizing: border-box; }
  .v { display: inline-block; width: 54%; font-weight: 600; vertical-align: top; }
  .n { display: inline-block; width: 6mm; color: #4f6a99; vertical-align: top; }
  .c { display: inline-block; width: calc(100% - 6mm); vertical-align: top; }
  tr.validity td { padding-top: 4mm; }
  tr.signature td { padding-top: 4mm; }
  .party { font-weight: 600; margin: 0; }
  .role { margin: 0.5mm 0 0; color: #4f6a99; }
  .line { border-top: 0.25mm solid #1d2233; padding-top: 1mm; margin: 13mm 0 0; color: #4f6a99; font-size: 8.5pt; }
  /* In the flow, after the signatures, so it closes the last page and never sits over the text. */
  .footer { margin-top: 10mm; padding-top: 1.5mm; font-size: 7.5pt; color: #777; direction: ltr; text-align: center; break-inside: avoid; }
</style>
</head>
<body>
${head.html}
<table class="bilingual">
${body(letter)}
</table>
<div class="footer">${escapeHtml(letter.reference)} · letter version ${version}</div>
</body>
</html>`;
}
