/**
 * A stand-in for the document engine's text extraction, for the synthetic
 * demonstration only (document intelligence D1): it "reads" a PDF by taking
 * the text the file itself carries — the string operands of its text
 * operators, or, for the plain synthetic samples the demonstration and the
 * tests produce, the file's own text. It does no layout analysis and no OCR,
 * so it reads only those samples; a real scanned document reads as empty.
 *
 * Selected only where a synthetic demonstration is permitted and the
 * institution's document engine is not configured; every finding it produces
 * is labelled FIXTURE. Anywhere else the engine is the institution's own
 * (adapters/nutrient/document-extraction.ts) or none.
 */
import type { DocumentExtractionPort, ExtractedContent } from '../../core/ports/document-extraction.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { type Result, ok } from '../../core/kernel/result.ts';

/** The most text taken from one file: a demonstration sample is small. */
const MAX_TEXT = 200_000;

/** String operands of PDF text operators: `(...) Tj` and the strings inside `[...] TJ`. */
const SHOWN = /\(((?:\\.|[^\\)])*)\)\s*T[jJ']/g;

function textOf(bytes: Uint8Array): string {
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, MAX_TEXT));
  const shown = [...raw.matchAll(SHOWN)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1'));
  if (shown.length > 0) return shown.join(' ');
  // The synthetic samples are plain text after the header: the PDF markers are stripped, the words kept.
  return raw
    .split('\n')
    .map((line) => line.replace(/^%+\s?/, ''))
    .filter((line) => !/^(PDF-\d|%EOF|EOF)$/.test(line.trim()))
    .join('\n');
}

export class DemonstrationDocumentExtraction implements DocumentExtractionPort {
  readonly source = 'FIXTURE' as const;

  extract(params: {
    readonly tenantId: string;
    readonly pdf: Uint8Array;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<ExtractedContent>>> {
    return Promise.resolve(ok({ kind: 'ANSWERED', value: { pages: [{ plainText: textOf(params.pdf), tables: [] }] } }));
  }
}
