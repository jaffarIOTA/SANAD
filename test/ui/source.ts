/**
 * Reads a source file for the tests that assert markup by reading `.tsx`
 * (Vitest cannot import the pages: their tsconfig preserves JSX for Next.js).
 *
 * The text is joined onto one line so that an assertion pins what the code
 * says, not where a formatter broke it: a line break just inside a round or
 * square bracket disappears (with the trailing comma before a closing one, as
 * the code would read on one line), a break after a tag's '>' or before a
 * '<' or a chained '.' disappears (JSX ignores it), and any other line break
 * becomes one space. Spacing within a line is left exactly as written.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const flatten = (src: string): string =>
  src
    .replace(/[ \t\r]+$/gm, '')
    .replace(/([([])\n\s*/g, '$1')
    .replace(/,?\n\s*([)\]])/g, '$1')
    .replace(/,\n\s*\}/g, ' }')
    .replace(/>\n\s*/g, '>')
    .replace(/\n\s*([<.])/g, '$1')
    .replace(/\n\s*/g, ' ');

/** A file exactly as written, for formats whose line structure is meaningful (YAML). */
export const raw = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');

/** A repository file, by its path from the repository root, joined onto one line. */
export const source = (path: string): string =>
  flatten(readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8'));
