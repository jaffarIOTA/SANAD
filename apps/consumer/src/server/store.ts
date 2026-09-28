/**
 * The consumer journey's development store: offers and acceptances, held on
 * `globalThis` so hot reloads keep them. In production both are rows in the
 * origination store; nothing about their shape is development-only.
 *
 * An acceptance records **which disclosure was shown** — the offer's
 * `disclosureVersion` — beside who accepted (by identity assertion, never by
 * identifier) and when (attested). That is the record a regulator asks for.
 */

import type { Offer } from '@sanad/core/products/offer.ts';
import { type TsaInstant, tsaInstant } from '@sanad/core/time/tsa.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

export interface StoredOffer {
  readonly offerId: string;
  readonly tenantId: string;
  readonly applicantRef: string;
  readonly productCode: string;
  readonly offer: Offer;
  /** Both calendars, fixed at quotation. Never converted at read time. */
  readonly maturityDateGregorian: string;
  readonly maturityDateHijri: string;
  readonly expiresAtEpochSeconds: bigint;
}

export interface Acceptance {
  readonly acceptanceId: string;
  readonly offerId: string;
  readonly disclosureVersion: string;
  readonly identityAssertionId: string;
  readonly localeShown: 'ar-SA' | 'en-SA';
  readonly acceptedAt: TsaInstant;
}

interface State {
  readonly offers: Map<string, StoredOffer>;
  readonly acceptances: Map<string, Acceptance>;
  sequence: number;
  lastAttested: bigint;
}

const KEY = Symbol.for('sanad.consumer.developmentStore');
const scope = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (scope[KEY] ??= { offers: new Map(), acceptances: new Map(), sequence: 0, lastAttested: 0n });

/**
 * Development stand-in for the timestamping authority. Reads the host clock;
 * production attests. Strictly monotonic, as an authority's genTime is: two
 * acts inside one second (accept, then book) get distinct, ordered instants.
 */
export function developmentAttestation(): TsaInstant {
  const now = BigInt(Math.floor(Date.now() / 1000));
  // A store kept across hot reloads may predate this field.
  const last = state.lastAttested ?? 0n;
  state.lastAttested = now > last ? now : last + 1n;
  return tsaInstant({ verified: true, genTimeEpochSeconds: state.lastAttested, tokenDigest: `development-substitute-${state.lastAttested.toString()}`, authorityId: 'development' });
}

export function nextId(prefix: string): string {
  state.sequence += 1;
  return `${prefix}_${String(state.sequence).padStart(5, '0')}`;
}

export function saveOffer(offer: StoredOffer): void { state.offers.set(offer.offerId, offer); }
export function findOffer(offerId: string): StoredOffer | undefined { return state.offers.get(offerId); }
export function acceptanceFor(offerId: string): Acceptance | undefined { return [...state.acceptances.values()].find((a) => a.offerId === offerId); }

export function accept(params: { readonly offerId: string; readonly identityAssertionId: string; readonly localeShown: Acceptance['localeShown']; readonly disclosureVersionShown: string; readonly at: TsaInstant }): Result<Acceptance> {
  const offer = state.offers.get(params.offerId);
  if (offer === undefined) return reject('OP-DETERMINACY', 'OFFER_NOT_FOUND', 'No such offer');
  if (params.identityAssertionId.trim().length === 0) return reject('OP-DETERMINACY', 'IDENTITY_ASSERTION_REQUIRED', 'Acceptance is bound to a verified identity assertion');
  if (acceptanceFor(params.offerId) !== undefined) return reject('OP-DETERMINACY', 'OFFER_ALREADY_ACCEPTED', 'This offer has already been accepted');
  if (params.at.epochSeconds > offer.expiresAtEpochSeconds) return reject('OP-DETERMINACY', 'OFFER_EXPIRED', 'This offer has expired; ask for a new one');
  // The acceptance is of the disclosure that was on the screen. If the offer
  // was re-quoted between showing and clicking, the versions differ and the
  // click accepts nothing.
  if (params.disclosureVersionShown !== offer.offer.disclosureVersion) return reject('OP-DETERMINACY', 'DISCLOSURE_VERSION_MISMATCH', 'The disclosure shown is not the current one; read it again');
  const acceptance: Acceptance = { acceptanceId: nextId('acc'), offerId: params.offerId, disclosureVersion: offer.offer.disclosureVersion, identityAssertionId: params.identityAssertionId, localeShown: params.localeShown, acceptedAt: params.at };
  state.acceptances.set(acceptance.acceptanceId, acceptance);
  return ok(acceptance);
}
