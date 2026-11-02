/**
 * The Facility Offer Letter as one self-contained HTML page, ready for a PDF
 * engine to print on A4 (through core/ports/pdf-generation.ts).
 *
 * Pure. It renders exactly the letter's content — the same figures the
 * screen previews and the customer signs, nothing computed here — Arabic
 * first (the governing text, right to left) and English beside it, with the
 * letter's version (the SHA-256 of its content) printed on every page so the
 * paper and the record can be matched. Every string is escaped; the page
 * loads nothing from outside (no font, no image, no script), so the engine
 * needs no network and nothing can be injected into the document.
 */
import type { BilingualText, OfferLetter } from './offer-letter.ts';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

type Lang = 'ar' | 'en';

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

function column(letter: OfferLetter, lang: Lang): string {
  const t = (b: BilingualText) => escapeHtml(b[lang]);
  const date = (d: OfferLetter['offerDate']) =>
    `${t(d.gregorian)}${d.hijri === undefined ? '' : ` <span class="hijri">(${escapeHtml(d.hijri)})</span>`}`;
  const rows = (rs: OfferLetter['terms']) =>
    rs.map((r) => `<tr><th>${t(r.label)}</th><td>${t(r.value)}</td></tr>`).join('');
  const label = (k: string) => t(LABELS[k] ?? { en: k, ar: k });
  return `<section class="col" lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}">
  <h1>${t(letter.title)}</h1>
  <p class="meta">${escapeHtml(letter.reference)} · ${label('offerDate')}: ${date(letter.offerDate)}</p>
  <table class="parties">
    <tr><th>${label('lender')}</th><td>${t(letter.parties.lender)}</td></tr>
    <tr><th>${label('borrower')}</th><td>${t(letter.parties.borrower)}</td></tr>
    <tr><th>${label('product')}</th><td>${t(letter.productVariant)}</td></tr>
  </table>
  <h2>${label('terms')}</h2>
  <table>${rows(letter.terms)}</table>
  <h2>${label('repayment')}</h2>
  <table>${rows(letter.repayment)}</table>
  <h2>${label('conditions')}</h2>
  <ol>${letter.conditions.map((c) => `<li>${t(c)}</li>`).join('')}</ol>
  <p class="validity">${t(letter.validity)}</p>
  <p class="meta">${label('validUntil')}: ${date(letter.validUntil)}</p>
  <h2>${label('signatures')}</h2>
  <div class="signatures">${letter.signatures
    .map(
      (s) =>
        `<div class="sig"><p><strong>${t(s.partyName)}</strong></p><p>${t(s.role)}</p><p class="line">${label('signHere')}</p></div>`,
    )
    .join('')}</div>
</section>`;
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
    const body = (closing ? tag.slice(1) : tag).replace(/\/$/, '');
    const nameEnd = body.search(/\s|$/);
    const name = body.slice(0, nameEnd);
    if (!SVG_ELEMENTS.has(name)) return undefined;
    let rest = body.slice(nameEnd);
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
  .footer { border-top: 0.3mm solid ${accent}; padding-top: 1.5mm; }`;
  return { html, css };
}

/** The letter as HTML: the letterhead when branded, Arabic column first, English beside it; the version in the footer. */
export function offerLetterHtml(letter: OfferLetter, branding?: LetterBranding): string {
  const version = escapeHtml(letter.version);
  const head = letterhead(branding);
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(letter.title.en)} — ${escapeHtml(letter.reference)}</title>
<style>
  @page { size: A4; margin: 18mm 14mm 20mm 14mm; }
  body { font-family: sans-serif; font-size: 10.5pt; color: #111; margin: 0; }
  .cols { display: flex; gap: 10mm; align-items: flex-start; }
  .col { flex: 1 1 0; min-width: 0; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  h2 { font-size: 10.5pt; margin: 5mm 0 1.5mm; text-transform: uppercase; letter-spacing: 0.02em; color: #444; }${head.css}
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 1.2mm 0; border-bottom: 0.2mm solid #ddd; vertical-align: top; text-align: start; }
  th { font-weight: normal; color: #555; width: 45%; padding-inline-end: 3mm; }
  td { font-weight: bold; }
  ol { padding-inline-start: 5mm; margin: 0; }
  li { margin-bottom: 1mm; }
  .meta { color: #555; font-size: 9pt; margin: 0 0 2mm; }
  .validity { margin-top: 4mm; }
  .signatures { display: flex; flex-direction: column; gap: 6mm; }
  .sig .line { border-top: 0.2mm solid #333; padding-top: 1mm; margin-top: 12mm; color: #555; font-size: 9pt; }
  /* In the flow, after the signatures, so it closes the last page and never sits over the text (a fixed footer
     in the page margin was printed over the content of the second page). */
  .footer { margin-top: 10mm; padding-top: 1.5mm; font-size: 7.5pt; color: #777; direction: ltr; text-align: center; break-inside: avoid; }
</style>
</head>
<body>
${head.html}
<div class="cols">
${column(letter, 'ar')}
${column(letter, 'en')}
</div>
<div class="footer">${escapeHtml(letter.reference)} · letter version ${version}</div>
</body>
</html>`;
}
