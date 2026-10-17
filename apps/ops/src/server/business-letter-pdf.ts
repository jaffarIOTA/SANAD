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
 */
import { createHash } from 'node:crypto';

import type { TenantCode } from '@sanad/config/loader.ts';
import { offerLetterHtml } from '@sanad/core/documents/offer-letter-html.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import type { StorableMediaType } from '@sanad/core/ports/object-storage.ts';
import { credentialProviderFromEnvironment } from '@sanad/origination/credentials.ts';

import { NutrientPdfGeneration } from '../../../../adapters/nutrient/pdf-generation.ts';
import { type BusinessApplicationView, getApplication, recordOfferPdf } from './business.ts';
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

/** The bytes of a rendered letter PDF, for the tenant's staff; a hash the application has not rendered reads nothing. */
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
  if (view?.letterPdfs.some((p) => p.sha256Hex === sha256Hex) !== true) return { kind: 'NOT_HELD' };
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
