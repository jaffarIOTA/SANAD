/**
 * The distributor's side of Wasl (W3): sign in as an authorised signatory,
 * see the sale offers and obligations of the distributor one signs for, and
 * accept an offer with a signature bound to the offer instrument.
 *
 * Identity: the national digital identity service, through its port
 * (`IdentityAuthenticationPort`). Only the demonstration transport stands
 * behind it yet, labelled, and only where a synthetic demonstration is
 * permitted (SR-005); anywhere else sign-in is refused until the live rail
 * has made a verified call. The person is named by a party reference, which
 * the service's egress resolves to the national identifier; the reference
 * must be a configured signatory of a distributor, and that configuration —
 * not the browser — says which distributor and which institution.
 *
 * Accepting: a signing intent bound to the SHA-256 of the offer leg's
 * instrument, confirmed by the same person in the identity app, then the
 * domain's acceptance (the same activity the Temporal workflow runs) with the
 * assertion recorded on it, then the booking of the obligation. A transaction
 * is shown, and can be accepted, only by a signatory of its own distributor.
 *
 * Reads no clock: instants are the host-clock stand-in's attestations.
 */
import { randomUUID } from 'node:crypto';

import { type TenantCode, signatoryOf } from '@sanad/config/loader.ts';
import type { ConsentLedger } from '@sanad/core/ports/consent-ledger.ts';
import { SecretValue } from '@sanad/core/ports/credentials.ts';
import type { IdentityAuthenticationPort } from '@sanad/core/ports/identity-authentication.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';
import { type TransactionView, getTransaction, listTransactions, waslPool } from '@sanad/origination/wasl/book.ts';
import { bookExecutedSale } from '@sanad/origination/wasl/booking.ts';
import { assertionReplayGuard } from '@sanad/origination/wasl/identity.ts';
import { civilDateOf, obligationPosition } from '@sanad/origination/wasl/settlement.ts';
import { acceptSaleOffer, scheduleFor } from '@sanad/origination/wasl/steps.ts';
import type { FacilityPosition } from '@sanad/core/servicing/instalment-position.ts';
import type { Instalment } from '@sanad/products/murabaha-scf/obligation/obligation.ts';

import { KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { NafathAdapter } from '../../../../adapters/ksa/nafath/adapter.ts';
import { type SmeSession, holdPending, startSession, takePending } from './session.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const attestedNow = (): number => Number(hostClockInstant().epochSeconds);

/** Identity needs no consent to authenticate a person to their own session. */
const NO_CONSENTS: ConsentLedger = {
  live: () => Promise.resolve(reject('OP-DETERMINACY', 'CONSENT_NOT_APPLICABLE', 'Signing in needs no consent')),
};

/** The identity service for a tenant, or undefined where none may be used (sign-in is then refused). */
export async function identityFor(
  tenant: TenantCode,
): Promise<{ readonly port: IdentityAuthenticationPort; readonly source: 'FIXTURE' } | undefined> {
  if (!(await syntheticDemonstrationPermitted(waslPool(), process.env))) return undefined;
  return {
    port: new NafathAdapter(
      {
        tenantId: tenant,
        provider: 'IDENTITY_AUTHENTICATION',
        environment: 'sandbox',
        freshnessWindowSeconds: 0,
        failurePosture: 'FAIL_CLOSED',
        credentialTtlSeconds: 600,
        breaker: { failureThreshold: 3, resetAfterSeconds: 30, successThreshold: 1 },
        nowEpochSeconds: attestedNow,
        baseUrl: 'https://demonstration.invalid',
        consents: NO_CONSENTS,
        assertionReplay: assertionReplayGuard(),
      },
      // The demonstration transport needs no credential; the adapter asks as it will of the vault.
      { get: () => Promise.resolve(new SecretValue('demonstration-transport-needs-no-credential')) },
      new KsaDemonstrationTransport(attestedNow),
    ),
    source: 'FIXTURE',
  };
}

/** Whether sign-in can be offered here at all: the screen says so rather than offering a form that cannot work. */
export const signInAvailable = (): Promise<boolean> => syntheticDemonstrationPermitted(waslPool(), process.env);

// -- Signing in -----------------------------------------------------------------------

/**
 * Start sign-in for a party reference. A reference that signs for no
 * distributor is refused here, before the identity service is asked — and in
 * the same words as a refusal by the service, so the form does not reveal
 * which references exist.
 */
export async function startSignIn(signatoryRef: string): Promise<Result<true>> {
  const ref = signatoryRef.trim().toLowerCase();
  const who = signatoryOf(ref);
  if (who === undefined) return fail('SIGN_IN_REFUSED', 'This person cannot sign in for a distributor here');
  const identity = await identityFor(who.tenant);
  if (identity === undefined) return fail('IDENTITY_UNAVAILABLE', 'The identity service is not connected here');
  const started = await identity.port.startAuthentication({
    tenantId: who.tenant,
    applicantRef: ref,
    purpose: 'LOGIN',
    correlationId: randomUUID(),
  });
  if (!started.ok) return started;
  if (started.value.kind === 'UNAVAILABLE')
    return fail('IDENTITY_UNAVAILABLE', 'The identity service did not answer; try again');
  if (started.value.kind !== 'ANSWERED')
    return fail('SIGN_IN_REFUSED', 'This person cannot sign in for a distributor here');
  await holdPending({ kind: 'SIGN_IN', signatoryRef: ref, identityTransactionRef: started.value.value.transactionRef });
  return ok(true);
}

/** Confirm sign-in once the person has approved in the identity app: the session names their distributor. */
export async function confirmSignIn(): Promise<Result<true>> {
  const pending = await takePending();
  if (pending?.kind !== 'SIGN_IN') return fail('SIGN_IN_EXPIRED', 'The sign-in request has expired; start again');
  const who = signatoryOf(pending.signatoryRef);
  if (who === undefined) return fail('SIGN_IN_REFUSED', 'This person cannot sign in for a distributor here');
  const identity = await identityFor(who.tenant);
  if (identity === undefined) return fail('IDENTITY_UNAVAILABLE', 'The identity service is not connected here');
  const confirmed = await identity.port.confirmAuthentication({
    tenantId: who.tenant,
    transactionRef: pending.identityTransactionRef,
    correlationId: randomUUID(),
  });
  if (!confirmed.ok) return confirmed;
  if (confirmed.value.kind === 'UNAVAILABLE')
    return fail('IDENTITY_UNAVAILABLE', 'The identity service did not answer; try again');
  if (confirmed.value.kind !== 'ANSWERED')
    return fail('IDENTITY_NOT_CONFIRMED', 'The identity service did not confirm the sign-in', {
      code: confirmed.value.kind === 'REFUSED' ? confirmed.value.code : 'MALFORMED',
    });
  await startSession({
    tenant: who.tenant,
    counterpartyId: who.distributor.counterpartyId,
    signatoryRef: pending.signatoryRef,
    identityAssertionId: confirmed.value.value.assertionId,
    authenticatedAtEpochSeconds: confirmed.value.value.authenticatedAtEpochSeconds,
  });
  return ok(true);
}

// -- What the distributor sees --------------------------------------------------------

/** The states a distributor sees: from the offer onwards. Nothing earlier is theirs to act on. */
const VISIBLE = new Set([
  'SALE_OFFERED',
  'OFFER_LAPSED',
  'EXECUTED',
  'ACTIVE',
  'SETTLED',
  'DELINQUENT',
  'HARDSHIP',
  'RESCHEDULED',
]);

export interface DistributorTransaction {
  readonly view: TransactionView;
  readonly schedule: readonly Instalment[] | undefined;
  /** Once booked: what is paid and outstanding today (W4a). */
  readonly position?: FacilityPosition;
}

const withPosition = (s: SmeSession, view: TransactionView): DistributorTransaction => {
  const position = obligationPosition(view, civilDateOf(s.tenant, hostClockInstant()));
  return { view, schedule: scheduleFor(s.tenant, view), ...(position === undefined ? {} : { position }) };
};

/** The signed-in signatory's distributor's transactions, offers first. Another distributor's are never listed. */
export async function myTransactions(s: SmeSession): Promise<readonly DistributorTransaction[]> {
  const all = await listTransactions(s.tenant);
  return all
    .filter((v) => v.transaction.core.counterpartyId === s.counterpartyId && VISIBLE.has(v.transaction.state))
    .map((view) => withPosition(s, view));
}

/** One of the distributor's own transactions; another distributor's is not found (BOLA). */
export async function myTransaction(
  s: SmeSession,
  transactionRef: string,
): Promise<DistributorTransaction | undefined> {
  if (!/^WT-\d{6,10}$/.test(transactionRef)) return undefined;
  const view = await getTransaction(s.tenant, transactionRef);
  if (view === undefined || view.transaction.core.counterpartyId !== s.counterpartyId) return undefined;
  if (!VISIBLE.has(view.transaction.state)) return undefined;
  return withPosition(s, view);
}

const offerLegOf = (v: TransactionView) =>
  v.transaction.state === 'SALE_OFFERED' ? v.transaction.legs.find((l) => l.legType === 'SALE_OFFER') : undefined;

// -- Accepting ------------------------------------------------------------------------

/** Open the signing intent on the offer instrument: the signature will be bound to its hash. */
export async function startAcceptance(s: SmeSession, transactionRef: string): Promise<Result<true>> {
  const mine = await myTransaction(s, transactionRef);
  if (mine === undefined) return fail('TRANSACTION_NOT_FOUND', 'No such offer');
  const t = mine.view.transaction;
  const offer = offerLegOf(mine.view);
  if (t.state !== 'SALE_OFFERED' || offer === undefined)
    return fail('OFFER_NOT_OPEN', 'This offer is not open for acceptance');
  // Checked again by the domain at acceptance; here so no one is asked to sign an offer that has already lapsed.
  if (BigInt(attestedNow()) > t.offerExpiresAtEpochSeconds)
    return reject('SH-03', 'OFFER_EXPIRED', 'The offer has lapsed and must be reissued');
  const identity = await identityFor(s.tenant);
  if (identity === undefined) return fail('IDENTITY_UNAVAILABLE', 'The identity service is not connected here');
  const started = await identity.port.startAuthentication({
    tenantId: s.tenant,
    applicantRef: s.signatoryRef,
    purpose: 'SIGNATURE_INTENT',
    documentHash: offer.contentHash,
    correlationId: randomUUID(),
  });
  if (!started.ok) return started;
  if (started.value.kind !== 'ANSWERED')
    return fail('IDENTITY_UNAVAILABLE', 'The identity service did not open the signature; nothing was signed');
  await holdPending({
    kind: 'SIGN_OFFER',
    signatoryRef: s.signatoryRef,
    identityTransactionRef: started.value.value.transactionRef,
    transactionRef,
    offerHash: offer.contentHash,
  });
  return ok(true);
}

/**
 * Confirm the signature and accept. The signature must be for this offer —
 * the instrument it was bound to is still the offer on the transaction — by
 * the person signed in. Then the acceptance (the domain's: strictly after the
 * offer, before it lapses, the goods to a party distinct from their seller),
 * then the booking. A booking the core could not take leaves the sale
 * executed, to be booked from the workbench; the acceptance stands.
 */
export async function confirmAcceptance(
  s: SmeSession,
): Promise<Result<{ readonly transactionRef: string; readonly booked: boolean }>> {
  const pending = await takePending();
  if (pending?.kind !== 'SIGN_OFFER' || pending.signatoryRef !== s.signatoryRef)
    return fail('SIGNATURE_EXPIRED', 'The signature request has expired; start again');
  const mine = await myTransaction(s, pending.transactionRef);
  const offer = mine === undefined ? undefined : offerLegOf(mine.view);
  if (offer?.contentHash !== pending.offerHash)
    return fail('OFFER_CHANGED', 'The offer is no longer the one that was signed; nothing was accepted');
  const identity = await identityFor(s.tenant);
  if (identity === undefined) return fail('IDENTITY_UNAVAILABLE', 'The identity service is not connected here');
  const confirmed = await identity.port.confirmAuthentication({
    tenantId: s.tenant,
    transactionRef: pending.identityTransactionRef,
    correlationId: randomUUID(),
  });
  if (!confirmed.ok) return confirmed;
  if (confirmed.value.kind !== 'ANSWERED')
    return fail('SIGNATURE_NOT_CONFIRMED', 'The identity service did not confirm the signature; nothing was accepted');
  const actor = `distributor:${s.signatoryRef}`;
  const accepted = await acceptSaleOffer(s.tenant, pending.transactionRef, actor, {
    assertionId: confirmed.value.value.assertionId,
    offerHash: pending.offerHash,
    signatoryRef: s.signatoryRef,
  });
  if (!accepted.ok) return accepted;
  const booked = await bookExecutedSale(s.tenant, pending.transactionRef, actor);
  return ok({ transactionRef: pending.transactionRef, booked: booked.ok });
}
