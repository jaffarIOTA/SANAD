/**
 * Turning a page the platform composed into a PDF (offer letters first). A
 * port: capability-named, vendor-free. The page is self-contained HTML; the
 * bytes come back as they are, and the caller fingerprints and stores them.
 * Unavailability is a typed outcome, never a throw: an engine that is down
 * renders nothing and the screen keeps the HTML preview.
 */
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface PdfGenerationPort {
  /** LIVE: the institution's document engine (which may itself be in an evaluation licence — see its README). */
  readonly source: 'LIVE' | 'FIXTURE';
  fromHtml(params: {
    readonly tenantId: string;
    readonly html: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly bytes: Uint8Array }>>>;
}
