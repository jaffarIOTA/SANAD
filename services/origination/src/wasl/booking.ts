/**
 * Booking an executed Murabaha (Wasl W3): the obligation and its schedule.
 *
 * Once the distributor has accepted, the sale exists and so does the debt —
 * a fixed total, the sale price, falling due on the schedule the offer
 * stated. Booking records it twice, by design:
 *
 *   Sanad   the obligation and its schedule (core.obligation, core.instalment),
 *           the booking of record: the total is fixed and the schedule sums to
 *           it, and the database refuses otherwise (SH-02);
 *   core    the receivable in the institution's core banking platform,
 *           account-shaped — the party, its collection account, a posting at
 *           the total with cost and profit as detail — through
 *           CoreBankingProvider.bookObligation. Never a loan contract: the
 *           lending module carries a rate, and a Murabaha has none (ADR 0007).
 *
 * The core is called first, idempotently (`wasl:<ref>:book`): if it does not
 * answer, nothing is written in Sanad and the transaction stays EXECUTED for a
 * retry, which books the same receivable rather than a second one. Only when
 * the core has answered does the transaction become ACTIVE, with the
 * obligation, in one database transaction.
 *
 * Which core: only the demonstration transport stands behind the Tuum adapter
 * yet, labelled FIXTURE, and only where a synthetic demonstration is
 * permitted. The live account-shaped booking waits on the tenant's own
 * posting codes and account hosts (verification item TUUM-ACCT-01); until
 * then booking elsewhere is refused as unavailable.
 */
import { randomUUID } from 'node:crypto';

import { type TenantCode, loadMurabahaAccounts, loadWaslParties } from '@sanad/config/loader.ts';
import { type Result, ok } from '@sanad/core/kernel/result.ts';
import type { CoreBankingProvider } from '@sanad/core/ports/core-banking.ts';
import { SecretValue } from '@sanad/core/ports/credentials.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import { createObligation } from '@sanad/products/murabaha-scf/obligation/obligation.ts';
import { bookObligation } from '@sanad/products/murabaha-scf/sequencing/transitions.ts';

import { TuumCoreBankingAdapter } from '../../../../adapters/tuum/core-banking-adapter.ts';
import { TuumDemonstrationTransport } from '../../../../adapters/tuum/demonstration.ts';
import { syntheticDemonstrationPermitted } from '../profile.ts';
import { type TransactionView, waslPool } from './book.ts';
import { fail, notNow, scheduleOf, step } from './steps.ts';

/**
 * The institution's core banking platform for holding a Murabaha, or a refusal where none may be reached.
 * Booking uses it; so does raising the charity liability on a collected late amount (late-amounts.ts).
 */
export async function coreBankingFor(
  tenant: TenantCode,
  at: TsaInstant,
): Promise<Result<{ readonly core: CoreBankingProvider; readonly source: 'FIXTURE' }>> {
  const accounts = loadMurabahaAccounts(tenant);
  if (!accounts.ok) return accounts;
  if (!(await syntheticDemonstrationPermitted(waslPool(), process.env)))
    return fail('CORE_BANKING_UNAVAILABLE', 'The core banking platform is not connected here; nothing was booked', {
      rail: 'CORE_BANKING',
    });
  const a = accounts.value;
  return ok({
    core: new TuumCoreBankingAdapter(
      {
        tenantId: tenant,
        provider: 'CORE_BANKING',
        environment: 'sandbox',
        freshnessWindowSeconds: 0,
        failurePosture: 'QUEUE_AND_RECONCILE',
        credentialTtlSeconds: 600,
        breaker: { failureThreshold: 3, resetAfterSeconds: 30, successThreshold: 1 },
        // The adapter's relative times hang from the step's attested instant, not a clock.
        nowEpochSeconds: () => Number(at.epochSeconds),
        hosts: {
          auth: 'https://auth.demonstration.invalid',
          person: 'https://person.demonstration.invalid',
          account: 'https://account.demonstration.invalid',
          payment: 'https://payment.demonstration.invalid',
        },
        accountPurposeCodes: a.accountPurposeCodes,
        institutionAccounts: a.institutionAccounts,
        transactionTypeCodes: a.transactionTypeCodes,
        channelCode: a.channelCode,
      },
      // The demonstration transport needs no credential; the adapter asks as it will of the vault.
      { get: () => Promise.resolve(new SecretValue('demonstration-transport-needs-no-credential')) },
      new TuumDemonstrationTransport(),
      // No restricted attributes travel for a company party in the demonstration.
      () => Promise.resolve({}),
    ),
    source: 'FIXTURE',
  });
}

/**
 * Book the executed sale: the receivable in the core first, then the
 * obligation and its schedule in Sanad, and the transaction ACTIVE.
 */
export function bookExecutedSale(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (t.state !== 'EXECUTED') return notNow(t.state);
    const core = t.core;
    const instalments = scheduleOf(c.terms, core);
    const obligationId = randomUUID();
    // The product module's own check: the schedule sums to the sale price, which is cost plus profit.
    const obligation = createObligation({
      obligationId,
      tenantId: core.tenantId,
      transactionId: core.transactionId,
      pricing: core.pricing,
      instalments,
    });
    if (!obligation.ok) return obligation;
    const parties = loadWaslParties(c.tenant);
    if (!parties.ok) return parties;
    const distributor = parties.value.distributors.find((d) => d.counterpartyId === core.counterpartyId);
    if (distributor === undefined)
      return fail('COUNTERPARTY_NOT_CONFIGURED', 'The distributor on this transaction is not onboarded');

    const at = await c.attestation.attest();
    const reached = await coreBankingFor(c.tenant, at);
    if (!reached.ok) return reached;
    const found = reached.value;
    const party = await found.core.resolveOrCreateParty(
      {
        tenantId: c.tenant,
        counterpartyId: core.counterpartyId,
        registrationNumber: distributor.registrationNo,
        legalNameAr: distributor.nameAr,
        legalNameEn: distributor.nameEn,
        legalForm: distributor.legalForm,
      },
      { value: `wasl:${transactionRef}:party` },
    );
    if (!party.ok) return party;
    const account = await found.core.resolveAccount(party.value, 'COLLECTION');
    if (!account.ok) return account;
    const booked = await found.core.bookObligation(
      {
        tenantId: c.tenant,
        transactionId: transactionRef,
        partyRef: party.value,
        collectionAccount: account.value,
        totalAmount: core.pricing.salePriceAmount,
        costAmount: core.pricing.costAmount,
        profitAmount: core.pricing.profitAmount,
        instalments,
        maturityDateGregorian: core.maturityDateGregorian,
        maturityDateHijri: core.maturityDateHijri,
        correlationId: core.correlationId,
      },
      { value: `wasl:${transactionRef}:book` },
    );
    if (!booked.ok) return booked;
    const bookingRef = booked.value.value;
    return ok({
      eventType: 'OBLIGATION_BOOKED',
      transaction: bookObligation(t, obligationId, bookingRef),
      obligation: { obligationId, total: core.pricing.salePriceAmount, bookingRef, instalments },
      detail: { coreBanking: found.source, collectionAccount: account.value.value },
    });
  });
}
