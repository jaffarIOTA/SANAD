/**
 * The Murabaha sequence in the workbench (Wasl W2): from DRAFT to the sale
 * offer, one step at a time, by the people whose job each step is.
 *
 * The steps themselves are shared with the SME portal
 * (services/origination/src/wasl/steps.ts) and re-exported here: each runs
 * through the same activities the Temporal workflow runs, calling the one
 * transition for its step, so the workbench has no path to a later state
 * than the sequencing engine allows.
 *
 * What stays here is the evidence only the workbench records, because it
 * needs the workbench's rails and store:
 *
 *   - Gate 1: the anchor's invoice to the institution, cleared by the
 *     e-invoicing authority — validated through the e-invoicing port, never
 *     keyed as a result.
 *   - Gate 2: possession evidence — a delivery note, a warehouse receipt —
 *     uploaded by operations to the object store, PENDING until a different
 *     person validates it (`decidePossessionEvidence`).
 *
 * This module reads no clock: every instant is the step's attested one.
 */
import { randomUUID } from 'node:crypto';

import type { TenantCode } from '@sanad/config/loader.ts';
import { acceptUpload } from '@sanad/core/documents/upload.ts';
import type { EvidenceRecord } from '@sanad/core/evidence/evidence.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { ConsentLedger } from '@sanad/core/ports/consent-ledger.ts';
import type { EInvoicingProvider } from '@sanad/core/ports/e-invoicing.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import type { TransactionView } from '@sanad/origination/wasl/book.ts';
import { POSSESSION_SOURCES, fail, notNow, possessionEvidenceTypes, step } from '@sanad/origination/wasl/steps.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import { KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { ZatcaEInvoicingAdapter } from '../../../../adapters/ksa/zatca-einvoicing/adapter.ts';
import { objectStorageFor } from './business-storage.ts';
import { DemonstrationCredentials, demonstrationConfig } from './intake-rails.ts';
import { persistencePool } from './persistence.ts';

export {
  POSSESSION_SOURCES,
  acceptSaleOffer,
  acquireOwnership,
  confirmPossession,
  decidePossessionEvidence,
  executePurchase,
  executeWaad,
  lapseSaleOffer,
  offerSale,
  possessionEvidenceTypes,
  recorderOf,
  scheduleFor,
  unwindTransaction,
  validateAndReserve,
} from '@sanad/origination/wasl/steps.ts';

// -- Gate 1: the ownership invoice ----------------------------------------------------

/** E-invoicing asks no consent: an invoice the institution is party to is its own record. */
const NO_CONSENTS: ConsentLedger = {
  live: () => Promise.resolve(reject('OP-DETERMINACY', 'CONSENT_NOT_APPLICABLE', 'An invoice lookup needs no consent')),
};

/**
 * The e-invoicing authority, as the port. Only the demonstration transport
 * stands behind it yet, labelled FIXTURE, and only where a synthetic
 * demonstration is permitted; it is told the invoice the transaction expects
 * (the anchor to the institution, for the cost), and its steering markers
 * still apply (a hash containing "reject" is not cleared, "unknown" is not
 * found). Anywhere else the authority is unavailable until the live adapter
 * has made a verified call (KSA-RAIL-ZATCA-01). The transport's relative
 * dates hang from the step's attested instant, not a clock.
 */
async function ownershipInvoiceRail(
  tenant: TenantCode,
  at: TsaInstant,
  expected: { readonly sellerCr: string; readonly buyerCr: string; readonly totalMinor: bigint },
): Promise<{ readonly provider: EInvoicingProvider; readonly source: 'FIXTURE' } | undefined> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(), process.env))) return undefined;
  const attested = () => Number(at.epochSeconds);
  return {
    provider: new ZatcaEInvoicingAdapter(
      demonstrationConfig(tenant, 'E_INVOICING', NO_CONSENTS, attested),
      new DemonstrationCredentials(),
      new KsaDemonstrationTransport(attested, () => expected),
    ),
    source: 'FIXTURE',
  };
}

const INVOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record the anchor's invoice to the institution as ownership evidence.
 * The e-invoicing authority answers; the evidence is VALID only if the
 * invoice is cleared, issued by the purchase's seller, names the institution
 * as buyer and is for the cost. An answer that fails any of those is recorded
 * INVALID — on file, discharging nothing.
 */
export function recordOwnershipInvoice(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  invoice: { readonly invoiceUuid: string; readonly invoiceHash: string },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (t.state !== 'PURCHASE_EXECUTED') return notNow(t.state);
    const invoiceUuid = invoice.invoiceUuid.trim().toLowerCase();
    const invoiceHash = invoice.invoiceHash.trim();
    if (!INVOICE_UUID.test(invoiceUuid) || invoiceHash.length === 0 || invoiceHash.length > 128)
      return fail('INVOICE_REFERENCE_MALFORMED', 'An invoice is named by its UUID and its hash');
    if (invoiceUuid === t.core.tradeReference.invoiceUuid?.toLowerCase())
      return fail(
        'OWNERSHIP_INVOICE_IS_THE_TRADE_INVOICE',
        'The financed invoice names the distributor; ownership is evidenced by the anchor’s invoice to the institution',
      );
    const artefactUri = `einvoice:${invoiceUuid}`;
    if (c.book.some((r) => r.evidence.some((e) => e.artefactUri === artefactUri && e.validationStatus === 'VALID')))
      return reject(
        'SH-10',
        'OWNERSHIP_INVOICE_ALREADY_EVIDENCED',
        'This invoice already evidences ownership of goods',
      );
    const sellerCr = t.core.tradeReference.issuerCr;
    const institutionCr = c.parties.institution.registrationNo;
    const cost = t.core.pricing.costAmount;
    const capturedAt = await c.attestation.attest();
    const rail = await ownershipInvoiceRail(c.tenant, capturedAt, {
      sellerCr,
      buyerCr: institutionCr,
      totalMinor: cost.minorUnits,
    });
    if (rail === undefined)
      return fail(
        'EINVOICING_UNAVAILABLE',
        'The e-invoicing authority cannot be reached from here; nothing was recorded',
      );
    const answered = await rail.provider.validateInvoice(c.tenant, { invoiceUuid, invoiceHash }, t.core.correlationId);
    if (!answered.ok) return answered;
    const v = answered.value;
    const recipientIsInstitution = v.recipientCr === institutionCr;
    const issuerIsSeller = v.issuerCr === sellerCr;
    const totalMatchesCost = v.totalAmount.minorUnits === cost.minorUnits && v.totalAmount.currency === cost.currency;
    // The demonstration cannot sign as the authority, so its stamp never verifies; a FIXTURE answer is labelled as such.
    const stampAccepted = v.stampValid || rail.source === 'FIXTURE';
    const valid =
      v.clearanceStatus === 'CLEARED' && recipientIsInstitution && issuerIsSeller && totalMatchesCost && stampAccepted;
    const evidence: EvidenceRecord = {
      evidenceId: randomUUID(),
      tenantId: t.core.tenantId,
      transactionId: t.core.transactionId,
      evidenceType: 'OWNERSHIP_INVOICE',
      gateSatisfied: 'GATE_1_OWNERSHIP',
      source: 'E_INVOICING_AUTHORITY',
      artefactUri,
      artefactHash: invoiceHash,
      capturedAt,
      validationStatus: valid ? 'VALID' : 'INVALID',
      validationDetail: {
        clearanceStatus: v.clearanceStatus,
        recipientIsInstitution,
        issuerIsSeller,
        totalMatchesCost,
        stampValid: v.stampValid,
        rail: rail.source,
      },
    };
    return ok({ eventType: 'EVIDENCE_RECORDED', transaction: t, evidence });
  });
}

// -- Gate 2: possession ---------------------------------------------------------------

/**
 * Record possession evidence: the file goes to the tenant's object store, the
 * evidence is recorded PENDING with its hash, and a different person
 * validates it before it can discharge gate 2.
 */
export function recordPossessionEvidence(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly evidenceType: string; readonly source: string; readonly bytes: Uint8Array },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (t.state !== 'OWNERSHIP_ACQUIRED') return notNow(t.state);
    const type = possessionEvidenceTypes(tenant).find((x) => x === input.evidenceType);
    if (type === undefined)
      return reject(
        'SH-05',
        'EVIDENCE_TYPE_NOT_ADMISSIBLE',
        'The structure does not admit this evidence for possession',
        {
          evidenceType: input.evidenceType,
        },
      );
    const source = POSSESSION_SOURCES.find((x) => x === input.source);
    if (source === undefined) return fail('EVIDENCE_SOURCE_UNKNOWN', 'Name where the evidence came from');
    const accepted = acceptUpload(input.bytes);
    if (!accepted.ok) return accepted;
    const { sha256Hex, mediaType, byteLength } = accepted.value;
    if (c.record.evidence.some((e) => e.artefactHash === sha256Hex && e.supersededBy === undefined))
      return fail('EVIDENCE_ALREADY_RECORDED', 'This file is already on the transaction');
    const store = await objectStorageFor(tenant);
    if (store === undefined)
      return fail('STORAGE_UNAVAILABLE', 'No document store is configured here; nothing was recorded');
    const put = await store.put({
      tenantId: tenant,
      objectKey: `${tenant}/transactions/${transactionRef}/${sha256Hex}`,
      bytes: input.bytes,
      mediaType,
      sha256Hex,
      correlationId: t.core.correlationId,
    });
    if (!put.ok) return put;
    if (put.value.kind !== 'ANSWERED')
      return fail('STORAGE_UNAVAILABLE', 'The document store did not take the file; nothing was recorded');
    const evidence: EvidenceRecord = {
      evidenceId: randomUUID(),
      tenantId: t.core.tenantId,
      transactionId: t.core.transactionId,
      evidenceType: type,
      gateSatisfied: 'GATE_2_POSSESSION',
      source,
      artefactUri: `obj:transactions/${transactionRef}/${sha256Hex}`,
      artefactHash: sha256Hex,
      // Attested over the file itself: the token proves these bytes existed at that instant (SR-006).
      capturedAt: await c.attestation.attestOver(sha256Hex),
      validationStatus: 'PENDING',
      validationDetail: { mediaType, byteLength, storage: store.source },
    };
    return ok({ eventType: 'EVIDENCE_RECORDED', transaction: t, evidence });
  });
}
