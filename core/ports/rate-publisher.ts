/**
 * The Rate Publisher (CLAUDE.md §4.3): an external organisation's API that
 * publishes benchmark rates and the market's APRs by product class.
 *
 * It informs pricing; it never sets a customer's rate. Every answer carries
 * the publisher's reference id, stored on the offer so the price can be
 * reproduced. Unavailable is a typed outcome — a benchmark-linked quote is
 * refused rather than priced on a stale rate.
 */

import type { Result } from '../kernel/result.ts';
import type { Rate } from '../pricing/rate.ts';
import type { TsaInstant } from '../time/tsa.ts';

export interface PublishedBenchmark {
  readonly code: string;
  readonly rate: Rate;
  readonly asOfEpochSeconds: bigint;
  readonly referenceId: string;
}

export interface MarketRange {
  readonly productClass: string;
  readonly lowBp: bigint;
  readonly medianBp: bigint;
  readonly highBp: bigint;
  readonly asOfEpochSeconds: bigint;
  readonly referenceId: string;
}

export type PublisherOutcome<T> = { readonly kind: 'PUBLISHED'; readonly value: T } | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export interface RatePublisherPort {
  benchmark(code: string, asOf: TsaInstant): Promise<Result<PublisherOutcome<PublishedBenchmark>>>;
  marketRates(productClass: string, asOf: TsaInstant): Promise<Result<PublisherOutcome<MarketRange>>>;
}
