/**
 * The published benchmark a benchmark-linked product is priced from (KSA K2;
 * CLAUDE.md §4.3): SAIBOR for the Saudi SME products. The Rate Publisher
 * informs the price, never sets it — the tenant's catalogue rule (benchmark +
 * margin) does — and its reference id is kept on the offer so the price can be
 * reproduced.
 *
 * The rail is the fenced one: the Saudi demonstration transport, labelled
 * Fixture, only where a synthetic demonstration is permitted. Elsewhere the
 * benchmark is unavailable and quotation is refused (BENCHMARK_UNAVAILABLE);
 * a stale or missing rate is never used silently.
 */
import { reject } from '@sanad/core/kernel/result.ts';
import type { ConsentLedger } from '@sanad/core/ports/consent-ledger.ts';
import type { PublishedBenchmark } from '@sanad/core/ports/rate-publisher.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import { KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { RatePublisherAdapter } from '../../../../adapters/ksa/rate-publisher/adapter.ts';
import { DemonstrationCredentials, demonstrationConfig } from './intake-rails.ts';
import { persistencePool } from './persistence.ts';

/** A published benchmark is public data: no consent is asked for, so none is held. */
const NO_CONSENTS: ConsentLedger = {
  live: () => Promise.resolve(reject('OP-DETERMINACY', 'CONSENT_NOT_APPLICABLE', 'A benchmark needs no consent')),
};

/** The benchmark at the attested instant, or undefined where none may be read (the quote is then refused). */
export async function publishedBenchmark(
  tenant: string,
  code: string,
  at: TsaInstant,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PublishedBenchmark | undefined> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(env), env))) return undefined;
  const now = () => Number(at.epochSeconds);
  const publisher = new RatePublisherAdapter(
    demonstrationConfig(tenant, 'RATE_PUBLISHER', NO_CONSENTS, now),
    new DemonstrationCredentials(),
    new KsaDemonstrationTransport(now),
  );
  const r = await publisher.benchmark(code, at);
  return r.ok && r.value.kind === 'PUBLISHED' ? r.value.value : undefined;
}
