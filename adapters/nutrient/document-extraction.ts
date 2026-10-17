/**
 * Reading a document's text and tables through Nutrient Document Engine:
 * `POST /api/build` with the PDF as a file part and `json-content` output.
 *
 * Verified against Document Engine 1.19.0 on 2026-10-17
 * (adapters/nutrient/verification/README.md, V-06): the engine itself reads
 * tables on a synthetic two-year statement, locally, with no cloud service,
 * so no document leaves the institution's engine. Findings that shape the
 * reader in core/documents/statement-figures.ts: two tables on a page may come
 * back as one grid, a header row of years may be dropped or appear mid-grid,
 * and Arabic plain text is not reliable on a rendered page (English labels and
 * digits are).
 *
 * The engine's confidence (0–100 with decimals, confirmed in V-06) becomes an
 * integer per ten thousand here, rounded down so a threshold is never met by
 * rounding; nothing past this file sees a float.
 * Where the engine is and its token come from the vault (./engine-endpoint.ts).
 * Error bodies are never read; a 4xx is REFUSED, a 5xx, timeout or open
 * circuit UNAVAILABLE, and an answer of the wrong shape UNAVAILABLE.
 */
import type { CredentialProvider } from '../../core/ports/credentials.ts';
import type {
  DocumentExtractionPort,
  ExtractedContent,
  ExtractedPage,
  ExtractedTable,
} from '../../core/ports/document-extraction.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { type Result, ok } from '../../core/kernel/result.ts';
import { CircuitBreaker, CircuitOpenError } from '../kernel/circuit-breaker.ts';
import { engineAuthorization, engineEndpoint } from './engine-endpoint.ts';

const MAX_PAGES = 200;
const MAX_CELLS = 20_000;
const MAX_TEXT = 200_000;

class EngineFailure extends Error {
  constructor(readonly status: number) {
    super(`document engine answered ${status}`);
  }
}

const perTenThousand = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(10_000, Math.max(0, Math.floor(v * 100))) : 0;

/** The engine's json-content answer in the port's terms, or undefined when it is not that shape. */
export function contentOf(raw: unknown): ExtractedContent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const pages = (raw as { pages?: unknown }).pages;
  if (!Array.isArray(pages) || pages.length > MAX_PAGES) return undefined;
  let cellCount = 0;
  const out: ExtractedPage[] = [];
  for (const p of pages) {
    if (typeof p !== 'object' || p === null) return undefined;
    const page = p as { plainText?: unknown; tables?: unknown };
    const tables: ExtractedTable[] = [];
    for (const t of Array.isArray(page.tables) ? page.tables : []) {
      if (typeof t !== 'object' || t === null) return undefined;
      const table = t as { confidence?: unknown; cells?: unknown };
      const cells: { row: number; column: number; text: string }[] = [];
      for (const c of Array.isArray(table.cells) ? table.cells : []) {
        const cell = c as { rowIndex?: unknown; columnIndex?: unknown; text?: unknown };
        if (!Number.isInteger(cell.rowIndex) || !Number.isInteger(cell.columnIndex)) return undefined;
        if (typeof cell.text !== 'string' || cell.text.length === 0) continue;
        cells.push({ row: cell.rowIndex as number, column: cell.columnIndex as number, text: cell.text.slice(0, 500) });
      }
      cellCount += cells.length;
      if (cellCount > MAX_CELLS) return undefined;
      tables.push({ confidencePerTenThousand: perTenThousand(table.confidence), cells });
    }
    out.push({ plainText: typeof page.plainText === 'string' ? page.plainText.slice(0, MAX_TEXT) : '', tables });
  }
  return { pages: out };
}

export class NutrientDocumentExtraction implements DocumentExtractionPort {
  readonly source = 'LIVE' as const;
  readonly #breaker: CircuitBreaker;
  readonly #fetch: typeof fetch;

  constructor(
    private readonly credentials: CredentialProvider,
    private readonly options: {
      readonly environment: 'sandbox' | 'uat' | 'production';
      readonly nowEpochSeconds: () => number;
      readonly fetchImpl?: typeof fetch;
      readonly timeoutMs?: number;
    },
  ) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#breaker = new CircuitBreaker('document-engine-extraction', {
      failureThreshold: 5,
      resetAfterSeconds: 30,
      successThreshold: 1,
      nowEpochSeconds: options.nowEpochSeconds,
    });
  }

  async extract(params: {
    readonly tenantId: string;
    readonly pdf: Uint8Array;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<ExtractedContent>>> {
    const endpoint = await engineEndpoint(
      this.credentials,
      params.tenantId,
      this.options.environment,
      params.correlationId,
    );
    if (!endpoint.ok) return ok({ kind: 'UNAVAILABLE', reason: endpoint.reason });
    const form = new FormData();
    form.append('document', new Blob([params.pdf], { type: 'application/pdf' }), 'document.pdf');
    form.append(
      'instructions',
      JSON.stringify({
        parts: [{ file: 'document' }],
        output: { type: 'json-content', plainText: true, tables: true },
      }),
    );
    try {
      const response = await this.#breaker.execute(async () => {
        const r = await this.#fetch(new URL('/api/build', endpoint.base), {
          method: 'POST',
          headers: { authorization: engineAuthorization(endpoint.token), 'x-request-id': params.correlationId },
          body: form,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
          redirect: 'error',
        });
        if (r.status >= 500) throw new EngineFailure(r.status);
        return r;
      });
      if (!response.ok) {
        await response.body?.cancel();
        return ok({ kind: 'REFUSED', code: `HTTP_${response.status}` });
      }
      const content = contentOf(await response.json());
      if (content === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'DOCUMENT_ENGINE_MALFORMED' });
      return ok({ kind: 'ANSWERED', value: content });
    } catch (e) {
      if (e instanceof SyntaxError) return ok({ kind: 'UNAVAILABLE', reason: 'DOCUMENT_ENGINE_MALFORMED' });
      if (e instanceof CircuitOpenError) return ok({ kind: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' });
      if (e instanceof EngineFailure) return ok({ kind: 'UNAVAILABLE', reason: `HTTP_${e.status}` });
      return ok({ kind: 'UNAVAILABLE', reason: 'NETWORK' });
    }
  }
}
