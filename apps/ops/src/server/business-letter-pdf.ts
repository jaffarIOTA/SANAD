/**
 * The offer letter as a real PDF: the letter's content rendered as bilingual
 * HTML (core/documents/offer-letter-html.ts), printed by the institution's
 * document engine (adapters/nutrient/pdf-generation.ts), fingerprinted,
 * stored in the tenant's object store, and recorded against the letter
 * version it renders.
 *
 * The letter version (the SHA-256 of the letter's content) is what the
 * customer signs; the PDF is its rendition and carries that version in its
 * footer. An engine that is not configured or does not answer renders
 * nothing; the screen keeps the HTML preview. A document engine in Nutrient's
 * evaluation mode (no licence key) watermarks what it prints.
 *
 * Once the customer has signed, the signed version's PDF is sealed with the
 * institution's digital signature (adapters/nutrient/document-signing.ts):
 * the engine embeds a PAdES signature made by the institution's signing
 * service, and the signed revision is stored by its own fingerprint beside
 * the PDF it seals. Here the signing service is the development one, with a
 * self-signed certificate (sandbox): plumbing, not a signature to rely on.
 */
import { createHash } from 'node:crypto';

import type { TenantCode } from '@sanad/config/loader.ts';
import { offerLetterHtml } from '@sanad/core/documents/offer-letter-html.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import type { StorableMediaType } from '@sanad/core/ports/object-storage.ts';
import { credentialProviderFromEnvironment } from '@sanad/origination/credentials.ts';

import { NutrientDocumentSigning } from '../../../../adapters/nutrient/document-signing.ts';
import { NutrientPdfGeneration } from '../../../../adapters/nutrient/pdf-generation.ts';
import {
  type BusinessApplicationView,
  getApplication,
  recordLetterSealed,
  recordOfferPdf,
  sealCandidate,
} from './business.ts';
import { objectKeyFor, objectStorageFor } from './business-storage.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

/** Render the given letter version (the latest when none is named) as a PDF and store it. */
export async function renderOfferPdf(
  tenant: TenantCode,
  applicationId: string,
  letterVersion: string | undefined,
  actor: string,
  correlationId: string,
): Promise<Result<BusinessApplicationView>> {
  const view = await getApplication(tenant, applicationId);
  if (view === undefined) return fail('BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  const offer =
    letterVersion === undefined ? view.latestOffer : view.offers.find((o) => o.letter.version === letterVersion);
  if (offer === undefined) return fail('OFFER_NOT_GENERATED', 'Generate the offer first');
  const engine = new NutrientPdfGeneration(credentialProviderFromEnvironment(), {
    environment: 'sandbox',
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  });
  const r = await engine.fromHtml({ tenantId: tenant, html: offerLetterHtml(offer.letter), correlationId });
  if (!r.ok) return r;
  if (r.value.kind !== 'ANSWERED')
    return fail('DOCUMENT_ENGINE_UNAVAILABLE', 'The document engine did not render the letter; nothing was stored', {
      outcome: r.value.kind,
    });
  const bytes = r.value.value.bytes;
  const sha256Hex = createHash('sha256').update(bytes).digest('hex');
  const store = await objectStorageFor(tenant);
  if (store === undefined)
    return fail('STORAGE_UNAVAILABLE', 'No document store is configured here; nothing was stored');
  const put = await store.put({
    tenantId: tenant,
    objectKey: objectKeyFor(tenant, applicationId, sha256Hex),
    bytes,
    mediaType: 'application/pdf',
    sha256Hex,
    correlationId,
  });
  if (!put.ok) return put;
  if (put.value.kind !== 'ANSWERED')
    return fail('STORAGE_UNAVAILABLE', 'The document store did not take the PDF; nothing was recorded');
  return recordOfferPdf(
    tenant,
    applicationId,
    { letterVersion: offer.letter.version, sha256Hex, byteLength: bytes.byteLength, storage: store.source },
    actor,
  );
}

/** Seal the signed letter's PDF with the institution's digital signature and store the sealed revision. */
export async function sealSignedLetter(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  correlationId: string,
): Promise<Result<BusinessApplicationView>> {
  const candidate = await sealCandidate(tenant, applicationId);
  if (!candidate.ok) return candidate;
  const { letterVersion, signatureRef, pdf } = candidate.value;
  const source = await readOfferPdf(tenant, applicationId, pdf.sha256Hex, correlationId);
  if (source.kind !== 'BYTES')
    return fail(
      source.kind === 'TAMPERED' ? 'OBJECT_TAMPERED' : 'STORAGE_UNAVAILABLE',
      'The stored letter PDF could not be read intact; nothing was sealed',
    );
  const environment = 'sandbox' as const;
  const signing = new NutrientDocumentSigning(credentialProviderFromEnvironment(), {
    environment,
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  });
  // References only: the signing service decides on purpose and version, and never sees a personal datum.
  const signingToken = JSON.stringify({ purpose: 'OFFER_LETTER_SEAL', tenant, letterVersion, signatureRef });
  const r = await signing.sealPdf({ tenantId: tenant, pdf: source.bytes, signingToken, correlationId });
  if (!r.ok) return r;
  if (r.value.kind !== 'ANSWERED')
    return fail('DOCUMENT_SIGNING_UNAVAILABLE', 'The document engine did not seal the letter; nothing was stored', {
      outcome: r.value.kind,
    });
  const { bytes, validation } = r.value.value;
  const sha256Hex = createHash('sha256').update(bytes).digest('hex');
  const store = await objectStorageFor(tenant);
  if (store === undefined)
    return fail('STORAGE_UNAVAILABLE', 'No document store is configured here; nothing was stored');
  if (!validation.signatureValid || !validation.chainValid || !validation.integrityValid)
    return fail('SEAL_NOT_VALID', 'The document engine did not validate the seal; nothing was stored');
  const put = await store.put({
    tenantId: tenant,
    objectKey: objectKeyFor(tenant, applicationId, sha256Hex),
    bytes,
    mediaType: 'application/pdf',
    sha256Hex,
    correlationId,
  });
  if (!put.ok) return put;
  if (put.value.kind !== 'ANSWERED')
    return fail('STORAGE_UNAVAILABLE', 'The document store did not take the sealed PDF; nothing was recorded');
  return recordLetterSealed(
    tenant,
    applicationId,
    {
      letterVersion,
      sourceSha256Hex: pdf.sha256Hex,
      sha256Hex,
      byteLength: bytes.byteLength,
      storage: store.source,
      environment,
      ...validation,
    },
    actor,
  );
}

/** The bytes of a rendered or sealed letter PDF, for the tenant's staff; a hash the application does not hold reads nothing. */
export async function readOfferPdf(
  tenant: TenantCode,
  applicationId: string,
  sha256Hex: string,
  correlationId: string,
): Promise<
  | { readonly kind: 'BYTES'; readonly bytes: Uint8Array; readonly mediaType: StorableMediaType }
  | { readonly kind: 'NOT_HELD' | 'UNAVAILABLE' | 'TAMPERED' }
> {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) return { kind: 'NOT_HELD' };
  const view = await getApplication(tenant, applicationId);
  if (view === undefined) return { kind: 'NOT_HELD' };
  if (
    !view.letterPdfs.some((p) => p.sha256Hex === sha256Hex) &&
    !view.sealedLetters.some((p) => p.sha256Hex === sha256Hex)
  )
    return { kind: 'NOT_HELD' };
  const store = await objectStorageFor(tenant);
  if (store === undefined) return { kind: 'UNAVAILABLE' };
  const got = await store.get({
    tenantId: tenant,
    objectKey: objectKeyFor(tenant, applicationId, sha256Hex),
    sha256Hex,
    correlationId,
  });
  if (!got.ok) return { kind: got.error.reason === 'OBJECT_TAMPERED' ? 'TAMPERED' : 'UNAVAILABLE' };
  if (got.value.kind !== 'ANSWERED') return { kind: 'UNAVAILABLE' };
  return { kind: 'BYTES', ...got.value.value };
}
