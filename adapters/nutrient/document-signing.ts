/**
 * Sealing a PDF through Nutrient Document Engine: upload, sign, download the
 * signed revision, delete the engine's copy.
 *
 * Verified against Document Engine 1.19.0 on 2026-10-17 with the development
 * signing service (adapters/nutrient/signing-service, check V-04 in
 * adapters/nutrient/verification/README.md): the engine asks the institution's
 * signing service for the certificates and a raw RSASSA-PKCS1-v1_5 signature,
 * builds the CAdES container itself and embeds it as PAdES. poppler's pdfsig,
 * an independent validator, found the signature valid.
 *
 * Two findings shape this adapter:
 * - the engine's stored source (`?source=true`) is the upload, not the signed
 *   file; the signed file is the rendition (`GET …/pdf`);
 * - in evaluation mode the rendition appends an incremental update after the
 *   signature (the watermark). The signature covers its own revision, so the
 *   adapter returns exactly that revision — the bytes up to the end of the
 *   newest signature's /ByteRange — and refuses anything it cannot cut cleanly.
 *
 * The container is RAW with signature type CAdES at baseline B-B: long-term
 * validation needs the certificate provider's timestamp and revocation
 * services, which is OI-06's finding, not this plumbing's. Where the engine
 * is and its token come from the vault (./engine-endpoint.ts). Error bodies are
 * never read; a 4xx is REFUSED, a 5xx, timeout or open circuit UNAVAILABLE.
 */
import type { CredentialProvider } from '../../core/ports/credentials.ts';
import type { DocumentSigningPort, SealValidation, SealedPdf } from '../../core/ports/document-signing.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { type Result, ok } from '../../core/kernel/result.ts';
import { CircuitBreaker, CircuitOpenError } from '../kernel/circuit-breaker.ts';
import { engineAuthorization, engineEndpoint } from './engine-endpoint.ts';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

class EngineFailure extends Error {
  constructor(readonly status: number) {
    super(`document engine answered ${status}`);
  }
}
class EngineRefusal extends Error {
  constructor(readonly status: number) {
    super(`document engine refused with ${status}`);
  }
}
class EngineMalformed extends Error {}

/**
 * The revision the newest signature covers: everything up to the end of its
 * /ByteRange. Undefined when there is no signature, the range runs past the
 * file, or the cut does not end on the revision's %%EOF.
 */
export function signedRevision(bytes: Uint8Array): Uint8Array | undefined {
  const text = new TextDecoder('latin1').decode(bytes);
  const ranges = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  const last = ranges.at(-1);
  if (last === undefined) return undefined;
  const [a, b, c, d] = [last[1], last[2], last[3], last[4]].map((x) => Number(x));
  if (a !== 0 || b === undefined || c === undefined || d === undefined || !(b < c)) return undefined;
  const end = c + d;
  if (end > bytes.byteLength) return undefined;
  if (!/%%EOF\s*$/.test(text.slice(Math.max(0, end - 16), end))) return undefined;
  return bytes.slice(0, end);
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

function validationOf(signature: unknown): SealValidation | undefined {
  if (typeof signature !== 'object' || signature === null) return undefined;
  const s = signature as Record<string, unknown>;
  const chain = Array.isArray(s['signingCertificateChain']) ? (s['signingCertificateChain'] as unknown[]) : [];
  const signer = chain.find(
    (c): c is Record<string, unknown> =>
      typeof c === 'object' && c !== null && (c as Record<string, unknown>)['isCACertificate'] === false,
  );
  if (signer === undefined) return undefined;
  return {
    padesLevel: asText(s['PAdESSignatureLevel']).slice(0, 16),
    signatureValid: s['signatureValidationStatus'] === 'valid',
    chainValid: s['certificateChainValidationStatus'] === 'ok',
    integrityValid: s['documentIntegrityStatus'] === 'ok',
    longTermValidation: s['ltv'] === true,
    signerCommonName: asText(signer['subjectCommonName']).slice(0, 200),
    issuerCommonName: asText(signer['issuerCommonName']).slice(0, 200),
    certificateSerialHex: asText(signer['serialNumberHex'])
      .replace(/[^0-9A-Fa-f]/g, '')
      .slice(0, 64),
  };
}

export class NutrientDocumentSigning implements DocumentSigningPort {
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
    this.#breaker = new CircuitBreaker('document-engine-signing', {
      failureThreshold: 5,
      resetAfterSeconds: 30,
      successThreshold: 1,
      nowEpochSeconds: options.nowEpochSeconds,
    });
  }

  async sealPdf(params: {
    readonly tenantId: string;
    readonly pdf: Uint8Array;
    readonly signingToken: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<SealedPdf>>> {
    const endpoint = await engineEndpoint(
      this.credentials,
      params.tenantId,
      this.options.environment,
      params.correlationId,
    );
    if (!endpoint.ok) return ok({ kind: 'UNAVAILABLE', reason: endpoint.reason });
    const headers = { authorization: engineAuthorization(endpoint.token), 'x-request-id': params.correlationId };
    // Only an outage counts against the circuit; a refusal is an answer.
    const call = async (path: string, init: RequestInit): Promise<Response> => {
      const r = await this.#breaker.execute(async () => {
        const answer = await this.#fetch(new URL(path, endpoint.base), {
          ...init,
          headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
          redirect: 'error',
        });
        if (answer.status >= 500) throw new EngineFailure(answer.status);
        return answer;
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw new EngineRefusal(r.status);
      }
      return r;
    };

    let documentId: string | undefined;
    try {
      const form = new FormData();
      form.append('file', new Blob([params.pdf], { type: 'application/pdf' }), 'document.pdf');
      const uploaded = (await (await call('/api/documents', { method: 'POST', body: form })).json()) as {
        data?: { document_id?: unknown };
      };
      const id = uploaded.data?.document_id;
      if (typeof id !== 'string' || !DOCUMENT_ID.test(id)) throw new EngineMalformed();
      documentId = id;

      const signed = (await (
        await call(`/api/documents/${id}/sign`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            signatureContainer: 'raw',
            signatureType: 'cades',
            cadesLevel: 'b-b',
            signingToken: params.signingToken,
          }),
        })
      ).json()) as { data?: { signature?: unknown } };
      const validation = validationOf(signed.data?.signature);
      if (validation === undefined) throw new EngineMalformed();

      const rendition = new Uint8Array(await (await call(`/api/documents/${id}/pdf`, { method: 'GET' })).arrayBuffer());
      if (rendition.byteLength > MAX_PDF_BYTES || String.fromCharCode(...rendition.slice(0, 5)) !== '%PDF-')
        throw new EngineMalformed();
      const bytes = signedRevision(rendition);
      if (bytes === undefined) throw new EngineMalformed();
      return ok({ kind: 'ANSWERED', value: { bytes, validation } });
    } catch (e) {
      if (e instanceof EngineRefusal) return ok({ kind: 'REFUSED', code: `HTTP_${e.status}` });
      if (e instanceof EngineMalformed || e instanceof SyntaxError)
        return ok({ kind: 'UNAVAILABLE', reason: 'DOCUMENT_ENGINE_MALFORMED' });
      if (e instanceof CircuitOpenError) return ok({ kind: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' });
      if (e instanceof EngineFailure) return ok({ kind: 'UNAVAILABLE', reason: `HTTP_${e.status}` });
      return ok({ kind: 'UNAVAILABLE', reason: 'NETWORK' });
    } finally {
      // The engine keeps nothing Sanad has finished with; a failed delete leaves a copy for the engine's retention to clear.
      if (documentId !== undefined)
        await this.#fetch(new URL(`/api/documents/${documentId}`, endpoint.base), {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        })
          .then((r) => r.body?.cancel())
          .catch(() => undefined);
    }
  }
}
