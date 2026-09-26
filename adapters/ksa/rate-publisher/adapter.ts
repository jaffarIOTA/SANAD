/**
 * Rate publisher — rate publisher adapter (CLAUDE.md §5).
 *
 * Implements the RatePublisherPort port. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { Result } from '../../../core/kernel/result.ts';
import { ok } from '../../../core/kernel/result.ts';
import { money } from '../../../core/kernel/money.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, bool, decimalToMinor, epoch, int, malformed, str } from '../kernel/rail-adapter.ts';
import type { RatePublisherPort, PublishedBenchmark, MarketRange, PublisherOutcome } from '../../../core/ports/rate-publisher.ts';
import type { TsaInstant } from '../../../core/time/tsa.ts';

export const RATEPUBLISHERADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'RATEPUB-DEV-001',
    summary: 'Rates are published as decimal percentages.',
    containment: 'Converted to integer basis points by digit manipulation at this boundary; a rate that does not parse exactly is UNAVAILABLE, never rounded through a float.',
    verificationRef: 'KSA-RAIL-RATEPUB-01',
  },
];

export class RatePublisherAdapter extends RailAdapter implements RatePublisherPort {
  readonly vendorName = 'Rate publisher';
  readonly capabilities = ['RATE_PUBLISHER'] as const;
  readonly deviations = RATEPUBLISHERADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async benchmark(code: string, asOf: TsaInstant): Promise<Result<PublisherOutcome<PublishedBenchmark>>> {
    const r = await this.invoke('rates.benchmark', { method: 'GET', path: `/v1/benchmarks/${encodeURIComponent(code)}?asOf=${asOf.epochSeconds.toString()}` }, `rates-${asOf.epochSeconds.toString()}`);
    if (r.kind !== 'ANSWERED') return ok({ kind: 'UNAVAILABLE' as const, reason: r.kind === 'REFUSED' ? `refused: ${r.code}` : r.reason });
    const bp = percentToBp(r.value['ratePercent']); const at = epoch(r.value['asOf']); const referenceId = str(r.value['publicationId']);
    if (bp === undefined || at === undefined || referenceId === undefined) return ok({ kind: 'UNAVAILABLE' as const, reason: 'response malformed' });
    return ok({ kind: 'PUBLISHED' as const, value: { code, rate: { bp, basis: 'REDUCING' as const, period: 'ANNUAL' as const }, asOfEpochSeconds: at, referenceId } });
  }

  async marketRates(productClass: string, asOf: TsaInstant): Promise<Result<PublisherOutcome<MarketRange>>> {
    const r = await this.invoke('rates.market', { method: 'GET', path: `/v1/market/${encodeURIComponent(productClass)}?asOf=${asOf.epochSeconds.toString()}` }, `rates-${asOf.epochSeconds.toString()}`);
    if (r.kind !== 'ANSWERED') return ok({ kind: 'UNAVAILABLE' as const, reason: r.kind === 'REFUSED' ? `refused: ${r.code}` : r.reason });
    const low = percentToBp(r.value['lowPercent']); const median = percentToBp(r.value['medianPercent']); const high = percentToBp(r.value['highPercent']); const at = epoch(r.value['asOf']); const referenceId = str(r.value['publicationId']);
    if (low === undefined || median === undefined || high === undefined || at === undefined || referenceId === undefined) return ok({ kind: 'UNAVAILABLE' as const, reason: 'response malformed' });
    return ok({ kind: 'PUBLISHED' as const, value: { productClass, lowBp: low, medianBp: median, highBp: high, asOfEpochSeconds: at, referenceId } });
  }
}

/** "7.25" → 725n. Two decimals of a percent are a basis point; more precision is refused, not rounded. */
export function percentToBp(v: unknown): bigint | undefined {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return undefined;
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (m === null) return undefined;
  const bp = BigInt(m[2] ?? '0') * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -bp : bp;
}
