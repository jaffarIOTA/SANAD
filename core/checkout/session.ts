/**
 * A checkout session: a merchant's basket becoming, with the shopper's
 * identity and acceptance, a booked buy-now-pay-later facility.
 *
 * The merchant creates it and can only ever cancel it; every other move is
 * the shopper's (identify, accept) or the platform's (offer, book, refuse,
 * expire). The basket amount is fixed at creation — the shopper does not type
 * an amount at checkout, the merchant's order is the amount — which is the
 * amount-first journey in its purest form.
 */

import type { Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';

export interface SessionCore {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly merchantId: string;
  readonly merchantOrderRef: string;
  readonly basket: Money;
  readonly productCode: string;
  readonly returnUrl: string;
  readonly cancelUrl: string;
  readonly createdAt: TsaInstant;
  readonly expiresAtEpochSeconds: bigint;
  readonly correlationId: string;
}

interface WithCore { readonly core: SessionCore }
export interface Created extends WithCore { readonly state: 'CREATED' }
export interface Identified extends WithCore { readonly state: 'IDENTIFIED'; readonly applicantRef: string; readonly identityAssertionId: string }
export interface Offered extends WithCore { readonly state: 'OFFERED'; readonly applicantRef: string; readonly identityAssertionId: string; readonly offerId: string; readonly disclosureVersion: string }
export interface Accepted extends WithCore { readonly state: 'ACCEPTED'; readonly applicantRef: string; readonly identityAssertionId: string; readonly offerId: string; readonly disclosureVersion: string; readonly acceptanceRef: string; readonly acceptedAt: TsaInstant }
export interface Booked extends WithCore { readonly state: 'BOOKED'; readonly applicantRef: string; readonly offerId: string; readonly acceptanceRef: string; readonly transactionId: string; readonly bookedAt: TsaInstant }
export interface Refused extends WithCore { readonly state: 'REFUSED'; readonly control: string; readonly reason: string }
export interface Cancelled extends WithCore { readonly state: 'CANCELLED'; readonly cancelledAt: TsaInstant }
export interface Expired extends WithCore { readonly state: 'EXPIRED'; readonly expiredAt: TsaInstant }
export type CheckoutSession = Created | Identified | Offered | Accepted | Booked | Refused | Cancelled | Expired;

const live = (s: CheckoutSession, at: TsaInstant): Result<true> =>
  at.epochSeconds > s.core.expiresAtEpochSeconds ? reject('OP-DETERMINACY', 'SESSION_EXPIRED', 'This checkout session has expired') : ok(true);

export function create(core: SessionCore): Result<Created> {
  if (core.basket.minorUnits <= 0n) return reject('OP-DETERMINACY', 'BASKET_NOT_POSITIVE', 'A basket has a positive amount');
  if (!/^https:\/\//.test(core.returnUrl) || !/^https:\/\//.test(core.cancelUrl)) return reject('OP-DETERMINACY', 'RETURN_URL_NOT_HTTPS', 'Return and cancel URLs are https');
  if (core.merchantOrderRef.trim().length === 0) return reject('OP-DETERMINACY', 'ORDER_REF_REQUIRED', 'The merchant’s order reference is required');
  if (core.expiresAtEpochSeconds <= core.createdAt.epochSeconds) return reject('OP-DETERMINACY', 'EXPIRY_NOT_LATER', 'A session expires after it is created');
  return ok({ state: 'CREATED', core });
}

export function identify(s: Created, applicantRef: string, identityAssertionId: string, at: TsaInstant): Result<Identified> {
  const alive = live(s, at); if (!alive.ok) return alive;
  if (identityAssertionId.trim().length === 0) return reject('OP-DETERMINACY', 'IDENTITY_ASSERTION_REQUIRED', 'Checkout continues only under a verified identity');
  return ok({ state: 'IDENTIFIED', core: s.core, applicantRef, identityAssertionId });
}

export function offer(s: Identified, offerId: string, disclosureVersion: string, at: TsaInstant): Result<Offered> {
  const alive = live(s, at); if (!alive.ok) return alive;
  return ok({ state: 'OFFERED', core: s.core, applicantRef: s.applicantRef, identityAssertionId: s.identityAssertionId, offerId, disclosureVersion });
}

export function refuse(s: Identified | Offered, control: string, reason: string): Refused {
  return { state: 'REFUSED', core: s.core, control, reason };
}

export function accept(s: Offered, acceptanceRef: string, disclosureVersionShown: string, at: TsaInstant): Result<Accepted> {
  const alive = live(s, at); if (!alive.ok) return alive;
  if (disclosureVersionShown !== s.disclosureVersion) return reject('OP-DETERMINACY', 'DISCLOSURE_VERSION_MISMATCH', 'The disclosure shown is not the one on offer');
  return ok({ state: 'ACCEPTED', core: s.core, applicantRef: s.applicantRef, identityAssertionId: s.identityAssertionId, offerId: s.offerId, disclosureVersion: s.disclosureVersion, acceptanceRef, acceptedAt: at });
}

export function book(s: Accepted, transactionId: string, at: TsaInstant): Booked {
  return { state: 'BOOKED', core: s.core, applicantRef: s.applicantRef, offerId: s.offerId, acceptanceRef: s.acceptanceRef, transactionId, bookedAt: at };
}

/** The merchant's one move. Nothing after acceptance can be cancelled from the shop. */
export function cancel(s: Created | Identified | Offered, at: TsaInstant): Cancelled {
  return { state: 'CANCELLED', core: s.core, cancelledAt: at };
}

export function expire(s: Created | Identified | Offered, at: TsaInstant): Result<Expired> {
  if (at.epochSeconds <= s.core.expiresAtEpochSeconds) return reject('OP-DETERMINACY', 'SESSION_NOT_YET_EXPIRED', 'The session is still live');
  return ok({ state: 'EXPIRED', core: s.core, expiredAt: at });
}

export const isTerminal = (s: CheckoutSession): boolean => s.state === 'BOOKED' || s.state === 'REFUSED' || s.state === 'CANCELLED' || s.state === 'EXPIRED';
