/**
 * PDF generation through Nutrient Document Engine (`POST /api/build` with an
 * HTML part), for pages the platform composes — the offer letter first.
 *
 * Verified against Document Engine 1.19.0 on 2026-10-17
 * (adapters/nutrient/verification/README.md, "Generation"): the build renders
 * a bilingual page with the Arabic joined and right to left. In the engine's
 * evaluation mode (Nutrient's trial, no licence key) exported documents carry
 * a watermark.
 *
 * Where the engine is and its token come from the vault on every call
 * (./engine-endpoint.ts): https, or plain http only to loopback. Its error
 * body is never read: a 4xx is REFUSED with the status, a 5xx, a timeout or an
 * open circuit is UNAVAILABLE. What comes back must be a PDF, and not a huge one.
 */
import type { CredentialProvider } from '../../core/ports/credentials.ts';
import type { PdfGenerationPort } from '../../core/ports/pdf-generation.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { type Result, ok } from '../../core/kernel/result.ts';
import { CircuitBreaker, CircuitOpenError } from '../kernel/circuit-breaker.ts';
import { engineAuthorization, engineEndpoint } from './engine-endpoint.ts';

const MAX_PDF_BYTES = 20 * 1024 * 1024;

class EngineFailure extends Error {
  constructor(readonly status: number) {
    super(`document engine answered ${status}`);
  }
}

export class NutrientPdfGeneration implements PdfGenerationPort {
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
    this.#breaker = new CircuitBreaker('document-engine', {
      failureThreshold: 5,
      resetAfterSeconds: 30,
      successThreshold: 1,
      nowEpochSeconds: options.nowEpochSeconds,
    });
  }

  async fromHtml(params: {
    readonly tenantId: string;
    readonly html: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly bytes: Uint8Array }>>> {
    const endpoint = await engineEndpoint(
      this.credentials,
      params.tenantId,
      this.options.environment,
      params.correlationId,
    );
    if (!endpoint.ok) return ok({ kind: 'UNAVAILABLE', reason: endpoint.reason });
    const url = new URL('/api/build', endpoint.base);
    const token = endpoint.token;

    const form = new FormData();
    form.append('page', new Blob([params.html], { type: 'text/html' }), 'page.html');
    form.append('instructions', JSON.stringify({ parts: [{ html: 'page' }], output: { type: 'pdf' } }));
    try {
      const response = await this.#breaker.execute(async () => {
        const r = await this.#fetch(url, {
          method: 'POST',
          headers: { authorization: engineAuthorization(token), 'x-request-id': params.correlationId },
          body: form,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
          redirect: 'error',
        });
        if (r.status >= 500) throw new EngineFailure(r.status);
        return r;
      });
      if (!response.ok) {
        await response.body?.cancel();
        return ok({ kind: 'REFUSED', code: `HTTP_${response.status}` });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > MAX_PDF_BYTES ||
        String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-'
      )
        return ok({ kind: 'UNAVAILABLE', reason: 'DOCUMENT_ENGINE_MALFORMED' });
      return ok({ kind: 'ANSWERED', value: { bytes } });
    } catch (e) {
      if (e instanceof CircuitOpenError) return ok({ kind: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' });
      if (e instanceof EngineFailure) return ok({ kind: 'UNAVAILABLE', reason: `HTTP_${e.status}` });
      return ok({ kind: 'UNAVAILABLE', reason: 'NETWORK' });
    }
  }
}
