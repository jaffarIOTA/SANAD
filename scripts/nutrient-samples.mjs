// Three synthetic sample documents for the verification checks. Every name,
// number and identifier is invented. Written as plain PDF syntax so no library
// is needed; the point is the shape of a document, not its typography.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '../adapters/nutrient/verification/samples');
mkdirSync(out, { recursive: true });

function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ['BT', '/F1 12 Tf', '14 TL', '50 780 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(body, 'latin1')); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const samples = {
  'synthetic-delivery-note.pdf': ['DELIVERY NOTE  (SYNTHETIC SAMPLE - NOT A REAL DOCUMENT)', 'Note no: DN-TEST-000123   Date: 14 September 2026 / 3 Rabi I 1448', 'Consignor: Example Materials Trading Est. (fictitious)', 'Consignee: Example Industrial Supplies Co. (fictitious)', 'Goods: Structural steel sections, 120 tonnes', 'Vehicle: TEST-0000   Driver: (not recorded)', 'Received in good order: ____________________'],
  'synthetic-commercial-invoice.pdf': ['TAX INVOICE  (SYNTHETIC SAMPLE - NOT A REAL DOCUMENT)', 'Invoice no: INV-TEST-452100   Issue date: 14 September 2026', 'Seller: Example Materials Trading Est.   VAT no: 300000000000003 (fictitious)', 'Buyer: Example Industrial Supplies Co.   VAT no: 300000000000011 (fictitious)', 'Line 1: Structural steel sections, 120 t @ SAR 1,340.58  = SAR 160,869.57', 'VAT 15%: SAR 24,130.43', 'Total: SAR 185,000.00', 'ZATCA clearance: (synthetic, none)'],
  'synthetic-identity-page.pdf': ['RESIDENT IDENTITY  (SYNTHETIC SAMPLE - NOT A REAL DOCUMENT)', 'Name: Test Person Example', 'ID number: 2000000000  (fabricated; fails the national checksum on purpose)', 'Date of birth: 01/01/1400 H', 'Nationality: Exampleland', 'Expiry: 01/01/1450 H', 'This page exists to test extraction and redaction shape only.'],
};
for (const [name, lines] of Object.entries(samples)) writeFileSync(join(out, name), pdf(lines));
console.log(`wrote ${String(Object.keys(samples).length)} synthetic samples to adapters/nutrient/verification/samples`);
