/**
 * Sealing a PDF with the institution's digital signature: the document
 * engine embeds a PAdES signature whose key the institution's signing service
 * holds, and reports how the result validates. A port: capability-named,
 * vendor-free.
 *
 * The seal is the institution's, on a document whose content the customer has
 * already signed through the national identity's signing intent; it makes the
 * paper verifiable by anyone with a PDF reader. What comes back is the signed
 * revision only — the bytes the signature covers, end to end — so its SHA-256
 * names exactly what was sealed. Unavailability is a typed outcome: nothing
 * is sealed and nothing is stored.
 */
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

/** How the engine validated the signature it embedded, as it reported it. */
export interface SealValidation {
  /** The PAdES baseline level reported (b-b, b-t, b-lt, b-lta). */
  readonly padesLevel: string;
  readonly signatureValid: boolean;
  /** The certificate chain builds to a root the engine trusts. */
  readonly chainValid: boolean;
  /** The signed bytes are intact. */
  readonly integrityValid: boolean;
  /** Long-term validation material (revocation data, timestamp) is embedded. */
  readonly longTermValidation: boolean;
  readonly signerCommonName: string;
  readonly issuerCommonName: string;
  readonly certificateSerialHex: string;
}

export interface SealedPdf {
  readonly bytes: Uint8Array;
  readonly validation: SealValidation;
}

export interface DocumentSigningPort {
  readonly source: 'LIVE' | 'FIXTURE';
  sealPdf(params: {
    readonly tenantId: string;
    readonly pdf: Uint8Array;
    /**
     * Passed unchanged to the institution's signing service, which decides
     * whether to sign: references only (purpose, letter version, the
     * customer's signature reference), never a personal datum.
     */
    readonly signingToken: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<SealedPdf>>>;
}
