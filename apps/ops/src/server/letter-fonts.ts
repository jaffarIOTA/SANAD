/**
 * The platform's typeface for printed letters: the same IBM Plex Sans Arabic
 * files the screens load (packages/design/fonts, foundation.css), read once
 * and embedded in the letter's HTML so the PDF is set as the screens are,
 * whatever fonts the document engine's host has. Regular for text, SemiBold
 * for figures, Bold for headings; each split by script, as on screen.
 *
 * A file that cannot be read leaves the letter on the engine's own sans-serif
 * rather than failing the render.
 */
import { readFileSync } from 'node:fs';

import type { LetterFontFace } from '@sanad/core/documents/offer-letter-html.ts';

const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const ARABIC =
  'U+0600-06FF, U+0750-077F, U+0870-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FEFC';

const FACES: readonly { readonly weight: LetterFontFace['weight']; readonly script: 'latin' | 'arabic' }[] = [
  { weight: 400, script: 'latin' },
  { weight: 400, script: 'arabic' },
  { weight: 600, script: 'latin' },
  { weight: 600, script: 'arabic' },
  { weight: 700, script: 'latin' },
  { weight: 700, script: 'arabic' },
];

let cached: readonly LetterFontFace[] | undefined;

export function letterFonts(): readonly LetterFontFace[] {
  if (cached !== undefined) return cached;
  const faces: LetterFontFace[] = [];
  for (const f of FACES) {
    try {
      const bytes = readFileSync(
        new URL(`../../../../packages/design/fonts/plex-sans-arabic-${f.script}-${f.weight}.woff2`, import.meta.url),
      );
      faces.push({
        weight: f.weight,
        unicodeRange: f.script === 'latin' ? LATIN : ARABIC,
        woff2Base64: bytes.toString('base64'),
      });
    } catch {
      // Left out: the letter falls back to the engine's sans-serif for this face.
    }
  }
  cached = faces;
  return faces;
}
