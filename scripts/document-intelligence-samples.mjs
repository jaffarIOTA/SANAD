// Synthetic sample documents for trying document intelligence (D1–D5) on a
// Saudi business application in the workbench. Every name, number and
// identifier is invented, and each page says so. Written as plain PDF syntax
// (as scripts/nutrient-samples.mjs) so no library is needed; the text is real
// PDF text, so both the demonstration reader and the document engine read it.
//
// Dated relative to today, so "expired" and "recent" stay true whenever this is
// run. The CR number and business name default to the walkthrough's Saudi
// intake (CR 1010000101, from the demonstration cast, which Wathq answers as
// active); pass another application's own to make the registration and name
// checks match it:
//
//   node scripts/document-intelligence-samples.mjs --cr 1010000101 --name "Riyadh Example Trading Co"
//
// Output: samples/document-intelligence/ (git-ignored; regenerate as needed).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const CR = arg('cr', '1010000101');
const NAME = arg('name', 'Riyadh Example Trading Co');
const OTHER_CR = CR.replace(/\d$/, (d) => String((Number(d) + 1) % 10));

const out = join(dirname(fileURLToPath(import.meta.url)), '../samples/document-intelligence');
mkdirSync(out, { recursive: true });

const DAY = 86_400_000;
const at = (days) => new Date(Date.now() + days * DAY);
/** dd/mm/yyyy, as written in the Kingdom. */
const dmy = (days) => {
  const d = at(days);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
/** yyyy/mm/dd on the Umm al-Qura calendar. */
const hijri = (days) => {
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatToParts(at(days));
  const p = (t) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('year').replace(/\D/g, '')}/${p('month')}/${p('day')}`;
};

function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 12 Tf', '16 TL', '50 780 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const SYNTHETIC = 'SYNTHETIC SAMPLE - NOT A REAL DOCUMENT';
const samples = {
  // Upload as: Commercial registration certificate. Expect every check to pass.
  '01-cr-current-matching.pdf': [
    'Kingdom of Saudi Arabia - Ministry of Commerce',
    `Commercial Registration  (${SYNTHETIC})`,
    `Business name: ${NAME}`,
    `CR Number ${CR}`,
    `Issue Date: ${dmy(-400)}   Expiry Date: ${dmy(300)}`,
  ],
  // Upload as: Commercial registration certificate. Expect: expired, and another company's number.
  '02-cr-expired-other-number.pdf': [
    'Kingdom of Saudi Arabia - Ministry of Commerce',
    `Commercial Registration  (${SYNTHETIC})`,
    `Business name: ${NAME}`,
    `CR Number ${OTHER_CR}`,
    `Issue Date: ${dmy(-800)}   Expiry Date: ${dmy(-5)}`,
  ],
  // Upload as: Company bank statements, 12 months. Expect: covers 12 months, ends recently, name found.
  '03-bank-statement-12-months.pdf': [
    `Example Bank - Account Statement  (${SYNTHETIC})`,
    `Account holder: ${NAME}`,
    `Statement Period: ${dmy(-375)} - ${dmy(-10)}`,
    'Opening Balance 120,000.00   Closing Balance 98,500.00',
  ],
  // Upload as: Company bank statements, 12 months. Expect: too short, and ended too long ago.
  '04-bank-statement-short-old.pdf': [
    `Example Bank - Account Statement  (${SYNTHETIC})`,
    `Account holder: ${NAME}`,
    `Statement Period: ${dmy(-260)} - ${dmy(-80)}`,
    'Opening Balance 120,000.00   Closing Balance 98,500.00',
  ],
  // Upload as: National ID or iqama. Expect: expired, the date shown in AH (Umm al-Qura).
  '05-national-id-hijri-expired.pdf': [
    'Kingdom of Saudi Arabia - Ministry of Interior',
    `National ID  (${SYNTHETIC})`,
    'Holder: Owner Example (fictitious)',
    `Expiry Date: ${hijri(-30)}`,
  ],
  // Upload as: SIMAH commercial credit report. Expect: issued within 30 days.
  '06-simah-report-recent.pdf': [
    `SIMAH - Saudi Credit Bureau - Commercial Credit Report  (${SYNTHETIC})`,
    `Subject: ${NAME}`,
    `Report Date: ${dmy(-5)}`,
  ],
  // Upload as: Commercial registration certificate. Expect: "reads as Zakat certificate - does not match".
  '07-zakat-certificate-wrong-slot.pdf': [
    'Zakat, Tax and Customs Authority',
    `Zakat Certificate  (${SYNTHETIC})`,
    `Taxpayer: ${NAME}`,
    `Issue Date: ${dmy(-20)}   Expiry Date: ${dmy(340)}`,
  ],
  // Upload as anything. Expect: not recognised, check it by eye.
  '08-unrecognised-minutes.pdf': [
    `Minutes of the weekly operations meeting  (${SYNTHETIC})`,
    'Attendees: three (fictitious)',
    'Items: stock count, delivery schedule',
  ],
};

for (const [file, lines] of Object.entries(samples)) writeFileSync(join(out, file), pdf(lines));
console.log(`Wrote ${Object.keys(samples).length} samples to ${out} (CR ${CR}, "${NAME}")`);
