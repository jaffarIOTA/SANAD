/**
 * An offer: a quote, its disclosure, and the APR the platform computed for it.
 *
 * `buildOffer` is the only way to make one, and `computeApr` is the only way
 * it gets its APR. The `apr.computedBy` field is a literal, so an offer whose
 * APR came from anywhere else is not an `Offer`; the compliance suite pins
 * that the constructor is the only one.
 */

import { createHash } from 'node:crypto';

import type { Result } from '../kernel/result.ts';
import { ok } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';
import { computeApr } from '../pricing/apr.ts';
import type { AnyProductModule, Disclosure, Quote } from './module.ts';

export const APR_AUTHORITY = 'core/pricing/apr.ts' as const;

export interface Offer {
  readonly productCode: string;
  readonly quote: Quote;
  readonly disclosure: Disclosure;
  readonly apr: { readonly bp: bigint; readonly computedBy: typeof APR_AUTHORITY };
  /** Hash of the disclosure as shown. The acceptance event records it. */
  readonly disclosureVersion: string;
  readonly quotedAt: TsaInstant;
}

export function buildOffer(module: AnyProductModule, quote: Quote, quotedAt: TsaInstant): Result<Offer> {
  const apr = computeApr(quote.schedule);
  if (!apr.ok) return apr;
  const disclosure = module.disclose(quote);
  return ok({
    productCode: module.descriptor.code,
    quote,
    disclosure,
    apr: { bp: apr.value.bp, computedBy: APR_AUTHORITY },
    disclosureVersion: disclosureHash(disclosure, apr.value.bp),
    quotedAt,
  });
}

function disclosureHash(disclosure: Disclosure, aprBp: bigint): string {
  const canonical = JSON.stringify(disclosure, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  return createHash('sha256').update(canonical).update(`|apr=${aprBp.toString()}`).digest('hex');
}
