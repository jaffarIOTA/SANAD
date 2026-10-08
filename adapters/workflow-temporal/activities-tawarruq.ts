/**
 * Tawarruq activities: each one calls the broker port for the real-world act
 * and the one domain transition for that step, with a fresh attestation.
 */

import type { Rejection } from '../../core/kernel/result.ts';
import type { CommodityBrokerPort } from '../../core/ports/commodity-broker.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import {
  disburse,
  purchaseCommodity,
  realiseProceeds,
  sellToCustomer,
  transferTitle,
  type TawarruqTransaction,
} from '../../products/tawarruq-personal/execution.ts';
import { SequenceRefusal } from './programs/murabaha.ts';
import type { Attestation, TawarruqStore } from './ports.ts';

export interface TawarruqPorts {
  readonly transactions: TawarruqStore;
  readonly broker: CommodityBrokerPort;
  readonly attestation: Attestation;
}

interface Ref {
  readonly tenantId: string;
  readonly transactionId: string;
}

const refusal = (r: Rejection): never => {
  throw new SequenceRefusal(r.reason, `${r.control}: ${r.detail}`);
};

/** A rail that is down is retried by the engine; a rail that refused is a sequence fact. */
function answered<T>(outcome: RailOutcome<T>, what: string): T {
  if (outcome.kind === 'ANSWERED') return outcome.value;
  if (outcome.kind === 'REFUSED') throw new SequenceRefusal('BROKER_REFUSED', `${what}: ${outcome.code}`);
  throw new Error(`${what}: broker unavailable (${outcome.reason})`);
}

export function createTawarruqActivities(ports: TawarruqPorts) {
  async function load(ref: Ref): Promise<TawarruqTransaction> {
    const t = await ports.transactions.load(ref.tenantId, ref.transactionId);
    if (t === undefined) throw new SequenceRefusal('TRANSACTION_NOT_FOUND', `No transaction ${ref.transactionId}`);
    return t;
  }
  function expect<S extends TawarruqTransaction['state']>(
    t: TawarruqTransaction,
    state: S,
  ): Extract<TawarruqTransaction, { state: S }> {
    if (t.state !== state) throw new SequenceRefusal('STATE_MISMATCH', `Expected ${state}, found ${t.state}`);
    return t as Extract<TawarruqTransaction, { state: S }>;
  }

  return {
    async purchaseCommodity(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'DRAFT');
      const bought = await ports.broker.purchase({
        tenantId: ref.tenantId,
        brokerRef: t.core.brokerRef,
        commodityCode: 'LME-AL',
        amount: t.core.quote.commodityCost,
        idempotencyKey: `txn:${ref.transactionId}:purchase`,
        correlationId: t.core.correlationId,
      });
      if (!bought.ok) return refusal(bought.error);
      const next = purchaseCommodity(t, answered(bought.value, 'purchase'), await ports.attestation.attest());
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },
    async sellToCustomer(ref: Ref, saleDocumentRef: string): Promise<void> {
      const t = expect(await load(ref), 'COMMODITY_PURCHASED');
      const next = sellToCustomer(t, saleDocumentRef, await ports.attestation.attest());
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },
    async transferTitle(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'SOLD_TO_CUSTOMER');
      const moved = await ports.broker.transferTitle({
        tenantId: ref.tenantId,
        lotRef: t.lot.lotRef,
        toPartyRef: t.core.applicantRef,
        correlationId: t.core.correlationId,
      });
      if (!moved.ok) return refusal(moved.error);
      const next = transferTitle(
        t,
        answered(moved.value, 'title transfer').transferRef,
        await ports.attestation.attest(),
      );
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },
    async realiseProceeds(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'TITLE_TRANSFERRED');
      const sold = await ports.broker.sellOnBehalf({
        tenantId: ref.tenantId,
        lotRef: t.lot.lotRef,
        onBehalfOfPartyRef: t.core.applicantRef,
        ...(t.core.agency.agencyRef === undefined ? {} : { agencyRef: t.core.agency.agencyRef }),
        idempotencyKey: `txn:${ref.transactionId}:sale`,
        correlationId: t.core.correlationId,
      });
      if (!sold.ok) return refusal(sold.error);
      const sale = answered(sold.value, 'onward sale');
      const next = realiseProceeds(
        t,
        {
          saleRef: sale.saleRef,
          proceeds: sale.proceeds,
          ...(t.core.agency.agencyRef === undefined ? {} : { agencyRef: t.core.agency.agencyRef }),
        },
        await ports.attestation.attest(),
      );
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },
    async disburse(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'PROCEEDS_REALISED');
      const next = disburse(t, await ports.attestation.attest());
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },
    async unwind(ref: Ref, reason: string): Promise<void> {
      // The commodity is still the institution's: dispose of it through the broker and record why.
      const t = await load(ref);
      if (t.state !== 'COMMODITY_PURCHASED')
        throw new SequenceRefusal('STATE_MISMATCH', `Nothing to unwind from ${t.state}: ${reason}`);
      const sold = await ports.broker.sellOnBehalf({
        tenantId: ref.tenantId,
        lotRef: t.lot.lotRef,
        onBehalfOfPartyRef: 'INSTITUTION',
        idempotencyKey: `txn:${ref.transactionId}:unwind`,
        correlationId: t.core.correlationId,
      });
      if (!sold.ok) return refusal(sold.error);
      answered(sold.value, 'unwind');
    },
  };
}

export type TawarruqActivities = ReturnType<typeof createTawarruqActivities>;
