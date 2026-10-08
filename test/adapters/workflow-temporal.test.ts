/**
 * The sequencing programs, run without a server.
 *
 * The property that matters most is the last one: the durable timer wakes
 * the workflow, and only a fresh attestation from the timestamping authority
 * lets gate 3 pass. A timer that could advance a transaction on its own would
 * be `new Date()` wearing a workflow engine.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadOriginationPolicy, loadProductCatalogue } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { eventsOfKind } from '@sanad/core/outbox/outbox.ts';
import type { CommodityBrokerPort } from '@sanad/core/ports/commodity-broker.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { tawarruqPersonal } from '@sanad/products/tawarruq-personal/index.ts';
import { retryFor } from '../../adapters/workflow-temporal/worker.ts';
import {
  MapEvidenceStore,
  MapTawarruqStore,
  MapTransactionStore,
  VirtualAttestation,
  fixedStructure,
  runMurabahaInMemory,
  runTawarruqInMemory,
  simpleLegPreparer,
} from '../../adapters/workflow-temporal/in-memory/runner.ts';
import {
  ANCHOR_CR,
  DISTRIBUTOR_CR,
  INSTITUTION_CR,
  TRANSACTION_ID,
  deliveryEvidence,
  ownershipEvidence,
  riskPeriodSecondsFor,
  structureFor,
  transactionCore,
} from '../support/fixtures.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const T0 = 1_791_000_000n;

function murabahaHarness(attestation: VirtualAttestation) {
  const transactions = new MapTransactionStore();
  const evidence = new MapEvidenceStore();
  const ports = {
    transactions,
    evidence,
    structures: fixedStructure(structureFor('bank-a')),
    legs: simpleLegPreparer(attestation, {
      institutionCr: INSTITUTION_CR,
      buyerCr: DISTRIBUTOR_CR,
      sellerCr: ANCHOR_CR,
    }),
    attestation,
  };
  const input = { tenantId: 'bank-a', transactionId: TRANSACTION_ID, offerValiditySeconds: 3_600, maxGateChecks: 6 };
  return {
    transactions,
    evidence,
    ports,
    input,
    seed: () => transactions.save({ state: 'DRAFT', core: transactionCore('bank-a') }),
  };
}

const arrives = (evidence: MapEvidenceStore) => async (gate: string, attestation: VirtualAttestation) => {
  attestation.advance(60);
  const at = await attestation.attest();
  if (gate === 'GATE_1_OWNERSHIP') evidence.add(ownershipEvidence(at));
  if (gate === 'GATE_2_POSSESSION') evidence.add(deliveryEvidence(at));
};

describe('the Murabaha sequence, end to end without a server', () => {
  it('walks every state in order, sleeps for the risk period, and books', async () => {
    const attestation = new VirtualAttestation(T0);
    const h = murabahaHarness(attestation);
    await h.seed();
    const run = await runMurabahaInMemory(h.ports, h.input, {
      onWaitEvidence: arrives(h.evidence),
      offerOutcome: 'ACCEPTED',
    });
    expect(run.outcome).toBe('BOOKED');
    expect(h.transactions.history).toEqual([
      'DRAFT',
      'LIMIT_RESERVED',
      'WAAD_EXECUTED',
      'PURCHASE_EXECUTED',
      'OWNERSHIP_ACQUIRED',
      'POSSESSION_CONFIRMED',
      'SALE_OFFERED',
      'EXECUTED',
      'ACTIVE',
    ]);
    // One durable sleep, for what the domain said remained: the risk period less
    // the seconds the authority had already attested since possession.
    const slept = run.slept.reduce((s, x) => s + x, 0);
    expect(slept).toBeGreaterThan(riskPeriodSecondsFor('bank-a') - 10);
    expect(slept).toBeLessThanOrEqual(riskPeriodSecondsFor('bank-a'));
    expect(run.progress).toContain('WAITING_GATE_3_RISK_PERIOD');
  });

  it('the timer is not the clock: waking without an attested elapse never passes gate 3', async () => {
    class FrozenAuthority extends VirtualAttestation {
      override advance(): void {
        /* the authority's time does not move */
      }
    }
    const attestation = new FrozenAuthority(T0);
    const h = murabahaHarness(attestation);
    await h.seed();
    await expect(
      runMurabahaInMemory(h.ports, h.input, { onWaitEvidence: arrives(h.evidence), offerOutcome: 'ACCEPTED' }),
    ).rejects.toMatchObject({ name: 'SequenceRefusal', reason: 'GATE_CHECKS_EXHAUSTED' });
    expect(h.transactions.history).not.toContain('SALE_OFFERED');
    expect(h.transactions.history.at(-1)).toBe('POSSESSION_CONFIRMED');
  });

  it('evidence for a later gate does not discharge the one in play', async () => {
    const attestation = new VirtualAttestation(T0);
    const h = murabahaHarness(attestation);
    await h.seed();
    let gate1Waits = 0;
    const run = await runMurabahaInMemory(h.ports, h.input, {
      onWaitEvidence: async (gate, a) => {
        a.advance(60);
        const at = await a.attest();
        if (gate === 'GATE_1_OWNERSHIP') {
          gate1Waits += 1;
          h.evidence.add(gate1Waits === 1 ? deliveryEvidence(at) : ownershipEvidence(at));
        }
        if (gate === 'GATE_2_POSSESSION') h.evidence.add(deliveryEvidence(at));
      },
      offerOutcome: 'ACCEPTED',
    });
    expect(gate1Waits).toBe(2);
    expect(run.outcome).toBe('BOOKED');
  });

  it('a lapsed offer unwinds rather than lingering', async () => {
    const attestation = new VirtualAttestation(T0);
    const h = murabahaHarness(attestation);
    await h.seed();
    const run = await runMurabahaInMemory(h.ports, h.input, {
      onWaitEvidence: arrives(h.evidence),
      offerOutcome: 'LAPSED',
    });
    expect(run.outcome).toBe('LAPSED_AND_UNWOUND');
    expect(h.transactions.history.slice(-2)).toEqual(['OFFER_LAPSED', 'UNWIND']);
  });

  it('a step out of sequence is a refusal, not a retry', async () => {
    const attestation = new VirtualAttestation(T0);
    const h = murabahaHarness(attestation);
    await h.transactions.save({ state: 'DRAFT', core: transactionCore('bank-a') });
    // Pretend the sequence was already past the offer: the program's first step must refuse.
    const { createMurabahaActivities } = await import('../../adapters/workflow-temporal/activities.ts');
    const acts = createMurabahaActivities(h.ports);
    await acts.validateAndReserve({ tenantId: 'bank-a', transactionId: TRANSACTION_ID });
    await expect(acts.validateAndReserve({ tenantId: 'bank-a', transactionId: TRANSACTION_ID })).rejects.toMatchObject({
      name: 'SequenceRefusal',
      reason: 'STATE_MISMATCH',
    });
  });
});

describe('the Tawarruq sequence', () => {
  const broker: CommodityBrokerPort = {
    purchase: (p) =>
      Promise.resolve(
        expectOkWrap({
          kind: 'ANSWERED',
          value: {
            lotRef: 'lot-1',
            commodityCode: p.commodityCode,
            quantity: '10',
            unit: 'MT',
            price: p.amount,
            confirmedAtEpochSeconds: T0,
          },
        }),
      ),
    transferTitle: () =>
      Promise.resolve(expectOkWrap({ kind: 'ANSWERED', value: { transferRef: 'tr-1', confirmedAtEpochSeconds: T0 } })),
    sellOnBehalf: () =>
      Promise.resolve(
        expectOkWrap({
          kind: 'ANSWERED',
          value: { saleRef: 's-1', proceeds: money(5_000_000n), confirmedAtEpochSeconds: T0 },
        }),
      ),
  };
  function expectOkWrap<T>(v: T) {
    return { ok: true as const, value: v };
  }
  function seeded(attestation: VirtualAttestation) {
    const catalogue = expectOk(loadProductCatalogue('bank-a'));
    const entry = expectOk(entryFor(catalogue, 'tawarruq-personal', 'prg-0001', T0));
    const terms = expectOk(tawarruqPersonal.validateTerms(entry.terms));
    const inputs = expectOk(
      resolvePricingInputs(entry.pricingRule, {
        principal: money(5_000_000n),
        tenorDays: 360,
        asOfEpochSeconds: T0,
        benchmark: { code: 'SAIBOR-3M', rate: rate(560n, 'REDUCING'), asOfEpochSeconds: T0, referenceId: 'p' },
        marketRange: {
          productClass: 'PERSONAL',
          lowBp: 600n,
          medianBp: 900n,
          highBp: 1_500n,
          asOfEpochSeconds: T0,
          referenceId: 'm',
        },
      }),
    );
    const quote = expectOk(
      tawarruqPersonal.quote(terms, {
        tenantId: 'bank-a',
        programmeId: 'prg-0001',
        counterpartyId: 'app',
        requestedAmount: money(5_000_000n),
        requestedTenorDays: 360,
        asOf: undefined as never,
        pricing: inputs,
        affordability: { monthlyIncome: money(3_000_000n), existingMonthlyObligations: money(0n) },
      }),
    );
    const approved = { state: 'APPROVED', core: { tenantId: 'bank-a' } } as never;
    const transactions = new MapTawarruqStore();
    return {
      transactions,
      terms,
      quote,
      approved,
      ports: { transactions, broker, attestation },
      seed: async () => {
        const at = await attestation.attest();
        const d = expectOk(
          tawarruqPersonal.execute(terms, approved, quote, {
            transactionId: 'txn-t',
            applicantRef: 'app',
            bureauEnquiryRef: 'enq',
            consentId: 'cns',
            openedAt: at,
            correlationId: 'c',
          }),
        );
        await transactions.save(d);
      },
    };
  }
  it('owns, sells, transfers title, realises and disburses — once each', async () => {
    const attestation = new VirtualAttestation(T0);
    const s = seeded(attestation);
    await s.seed();
    const run = await runTawarruqInMemory(
      s.ports,
      { tenantId: 'bank-a', transactionId: 'txn-t', signatureTimeoutSeconds: 600 },
      { signature: 'SIGNED' },
    );
    expect(run.outcome).toBe('DISBURSED');
    expect(s.transactions.history).toEqual([
      'DRAFT',
      'COMMODITY_PURCHASED',
      'SOLD_TO_CUSTOMER',
      'TITLE_TRANSFERRED',
      'PROCEEDS_REALISED',
      'DISBURSED',
    ]);
    const final = await s.transactions.load('bank-a', 'txn-t');
    if (final?.state === 'DISBURSED') {
      expect(eventsOfKind(final.outbox, 'PAYMENT_DISBURSE')).toHaveLength(1);
      expect(eventsOfKind(final.outbox, 'BUREAU_REPORT')).toHaveLength(1);
    }
  });
  it('an unsigned sale unwinds the commodity and sells nothing to the customer', async () => {
    const attestation = new VirtualAttestation(T0);
    const s = seeded(attestation);
    await s.seed();
    const run = await runTawarruqInMemory(
      s.ports,
      { tenantId: 'bank-a', transactionId: 'txn-t', signatureTimeoutSeconds: 600 },
      { signature: 'TIMED_OUT' },
    );
    expect(run.outcome).toBe('UNWOUND');
    expect(s.transactions.history).toEqual(['DRAFT', 'COMMODITY_PURCHASED']);
  });
});

describe('the workflow code stays deterministic', () => {
  const files = [
    'adapters/workflow-temporal/workflows/index.ts',
    ...readdirSync(`${ROOT}adapters/workflow-temporal/programs`).map((f) => `adapters/workflow-temporal/programs/${f}`),
  ];
  it.each(files)('%s imports no Node built-in, no domain value, and reads no clock', (file) => {
    const src = readFileSync(`${ROOT}${file}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/from 'node:/);
    for (const m of src.matchAll(/^import\s+(?!type\s)[^;]*from\s+'([^']+)'/gm)) {
      expect(m[1], `${file}: value import ${m[1] ?? ''}`).toMatch(/^@temporalio\/workflow$|^\.\.?\/programs\//);
    }
    expect(src).not.toMatch(/new Date\(|Date\.now\(|Math\.random\(/);
  });
  it('maps the tenant retry policy onto the activity retry options', () => {
    const r = retryFor(expectOk(loadOriginationPolicy('bank-a')));
    expect(r).toEqual({ maxAttempts: 3, backoffSeconds: 300 });
  });
});
