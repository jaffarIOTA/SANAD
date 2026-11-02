/**
 * Reading the content of a document the applicant uploaded: each page's text
 * and the tables found on it, as cell texts on a grid. A port:
 * capability-named, vendor-free. What the text means is decided elsewhere
 * (core/documents/statement-figures.ts) and verified by a person; this only
 * reads. Unavailability is a typed outcome: nothing is read and nothing is
 * proposed.
 */
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface ExtractedTable {
  /** How sure the reader is of the table's structure, per ten thousand (9000 = 90%). */
  readonly confidencePerTenThousand: number;
  /** Row and column from 0; column 0 is the leftmost as read. Empty cells may be absent. */
  readonly cells: readonly { readonly row: number; readonly column: number; readonly text: string }[];
}

export interface ExtractedPage {
  readonly plainText: string;
  readonly tables: readonly ExtractedTable[];
}

export interface ExtractedContent {
  readonly pages: readonly ExtractedPage[];
}

export interface DocumentExtractionPort {
  readonly source: 'LIVE' | 'FIXTURE';
  extract(params: {
    readonly tenantId: string;
    readonly pdf: Uint8Array;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<ExtractedContent>>>;
}
