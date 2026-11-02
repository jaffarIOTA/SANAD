/**
 * Booking a consumer loan in the institution's loan system and servicing it
 * there (BNPL first; core/servicing/core-held-loan.ts decides, this file acts).
 *
 * - Booking: the loan system creates the customer, opens the loan's servicing
 *   account (or uses the customer's own account when they chose to be debited
 *   from it) and the loan contract on the terms disclosed and accepted. A direct
 *   call, idempotent on `loan:<ref>:book`, as the SME booking is (UAE M6).
 * - Servicing, for a date: read the loan system's position; post into the
 *   servicing account every collection that settled and is not yet posted;
 *   queue a collection on the transactional outbox for each instalment due,
 *   through the customer's channel; report an instalment the loan system shows
 *   overdue to the bureau and remind the customer, once each; report the loan
 *   closed when it is paid. Repeatable: a second run for the same day plans
 *   nothing twice.
 * - A collection's result arrives from its rail (a bill paid, a debit settled
 *   or returned, an initiated payment settled) and is recorded by
 *   `recordCollectionResult`. In a synthetic demonstration the rails are
 *   fixtures, so the run can stand in for their answer, labelled Fixture.
 *
 * The tenant must be active under the deployment's jurisdiction, and the loan's
 * channel must be one its jurisdiction carries (a Saudi bill scheme is never a
 * UAE collection method, and the reverse). A live loan system answers only for
 * its own today.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  type TenantCode,
  loadLoanBookingConfig,
  loadOriginationPolicy,
  loadTenantJurisdiction,
} from '../../../config/loader.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { OutboxEvent } from '../../../core/outbox/outbox.ts';
import type { LoanPosition } from '../../../core/ports/loan-servicing.ts';
import { type CoreHeldLoanEvent, collectionEventKind, planServicing } from '../../../core/servicing/core-held-loan.ts';
import { postgresOutboxStore } from '../../outbox/src/postgres-store.ts';
import { civilDateOf } from './civil-date.ts';
import { type ConsumerLoanView, listConsumerLoans, recordLoanEvents } from './consumer-loans.ts';
import { tenantUuidByCode } from './credentials.ts';
import { deploymentJurisdiction } from './jurisdiction.ts';
import { type LoanSystem, loanSystemFor } from './loan-system.ts';
import { syntheticDemonstrationPermitted } from './profile.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ServicingRun {
  readonly loanRef: string;
  readonly source: 'LIVE' | 'FIXTURE';
  readonly asOf: string;
  readonly position: LoanPosition;
  readonly booked: boolean;
  readonly posted: number;
  readonly queued: number;
  readonly settled: number;
  readonly returned: number;
  readonly overdue: number;
  readonly closed: boolean;
}

async function context(
  pool: Pool,
  tenant: TenantCode,
  loanRef: string,
): Promise<Result<{ view: ConsumerLoanView; system: LoanSystem; loanTypeCode: string }>> {
  const deployment = await deploymentJurisdiction();
  if (!deployment.activeTenants.includes(tenant))
    return fail('TENANT_NOT_ACTIVE', 'This institution is not active under the deployment’s jurisdiction', { tenant });
  const jurisdiction = loadTenantJurisdiction(tenant);
  if (!jurisdiction.ok) return jurisdiction;
  const [view] = await listConsumerLoans(pool, tenant, loanRef);
  if (view === undefined) return fail('LOAN_NOT_FOUND', 'No consumer loan with this reference', { loanRef });
  if (jurisdiction.value.collectionChannels[view.loan.collectionChannel] === undefined)
    return fail(
      'COLLECTION_CHANNEL_NOT_PERMITTED',
      'This collection channel is not carried in the institution’s jurisdiction',
      {
        channel: view.loan.collectionChannel,
        jurisdiction: jurisdiction.value.code,
      },
    );
  if (view.loan.currency !== jurisdiction.value.currency)
    return fail('CURRENCY_NOT_TENANT', 'The loan is not in the institution’s currency', {
      currency: view.loan.currency,
    });
  const config = loadLoanBookingConfig(tenant);
  if (!config.ok) return config;
  const mapped = config.value.products[view.loan.productCode];
  if (mapped === undefined)
    return fail('LOAN_PRODUCT_NOT_MAPPED', 'This product has no loan-system product code configured', {
      productCode: view.loan.productCode,
    });
  const system = await loanSystemFor(tenant, config.value, pool);
  if (system === undefined)
    return fail('RAIL_UNAVAILABLE', 'The loan system is not connected here; nothing was done', {
      rail: 'CORE_BANKING',
    });
  return ok({ view, system, loanTypeCode: mapped.loanTypeCode });
}

const bookingOf = (view: ConsumerLoanView) => view.events.find((e) => e.kind === 'BOOKED_IN_LOAN_SYSTEM');

/** Book the loan in the loan system on the terms accepted. Booking an already booked loan does nothing. */
export async function bookConsumerLoan(
  pool: Pool,
  tenant: TenantCode,
  loanRef: string,
  actor: string,
): Promise<Result<CoreHeldLoanEvent>> {
  const c = await context(pool, tenant, loanRef);
  if (!c.ok) return c;
  const { view, system, loanTypeCode } = c.value;
  const existing = bookingOf(view);
  if (existing !== undefined) return ok(existing);
  const l = view.loan;
  const own = l.collectionChannel === 'OWN_ACCOUNT';
  const booked = await system.bookLoan({
    tenantId: tenant,
    applicationId: l.loanRef,
    borrower: { kind: 'PERSON', partyRef: l.applicantRef, restrictedAttributesRef: `identity:${l.applicantRef}` },
    productCode: loanTypeCode,
    principal: { minorUnits: l.principalMinorUnits, currency: l.currency },
    rateBp: l.rateBp,
    aprBp: l.aprBp,
    numberOfPayments: l.numberOfInstalments,
    firstPaymentDate: l.firstDueDate,
    intervalDays: l.intervalDays,
    ...(own ? { ownAccountRef: l.collectionMandateRef } : { openServicingAccount: true }),
    idempotencyKey: `loan:${l.loanRef}:book`,
    correlationId: l.correlationId,
  });
  if (!booked.ok) return booked;
  if (booked.value.kind === 'UNAVAILABLE')
    return fail(
      'RAIL_UNAVAILABLE',
      'The loan system did not answer; nothing was booked. Try again: the booking is idempotent',
      {
        rail: 'CORE_BANKING',
        reason: booked.value.reason,
      },
    );
  if (booked.value.kind === 'REFUSED')
    return fail(
      booked.value.code === 'RATE_MISMATCH' ? 'LOAN_RATE_MISMATCH' : 'LOAN_BOOKING_REFUSED',
      'The loan system did not book the loan',
      { code: booked.value.code },
    );
  const b = booked.value.value;
  const event: CoreHeldLoanEvent = {
    kind: 'BOOKED_IN_LOAN_SYSTEM',
    idempotencyKey: `loan:${l.loanRef}:book`,
    detail: {
      loanAccountNumber: b.loanAccountNumber,
      contractRef: b.contractRef,
      customerRef: b.customerRef,
      servicingAccountRef: b.servicingAccountRef ?? '',
      loanTypeCode,
      source: system.source,
    },
  };
  await recordLoanEvents(pool, tenant, l.loanRef, [event], actor, l.correlationId);
  return ok(event);
}

/** Where the loan stands in the loan system on `asOf`. */
export async function consumerLoanPosition(
  pool: Pool,
  tenant: TenantCode,
  loanRef: string,
  asOf: string,
): Promise<Result<{ position: LoanPosition; source: 'LIVE' | 'FIXTURE' }>> {
  const c = await context(pool, tenant, loanRef);
  if (!c.ok) return c;
  const booking = bookingOf(c.value.view);
  if (booking === undefined) return fail('LOAN_NOT_BOOKED', 'The loan is not booked in the loan system yet');
  return readPosition(c.value.system, tenant, booking, asOf, c.value.view.loan.correlationId);
}

async function readPosition(
  system: LoanSystem,
  tenant: TenantCode,
  booking: CoreHeldLoanEvent,
  asOf: string,
  correlationId: string,
): Promise<Result<{ position: LoanPosition; source: 'LIVE' | 'FIXTURE' }>> {
  if (!DATE.test(asOf)) return fail('AS_OF_INVALID', 'The servicing date is yyyy-mm-dd');
  if (system.source === 'LIVE') {
    const today = civilDateOf(tenant, { epochSeconds: BigInt(Math.floor(Date.now() / 1000)) });
    if (asOf !== today) return fail('AS_OF_NOT_TODAY', 'A live loan system answers only for its own today', { today });
  }
  const read = await system.position({
    tenantId: tenant,
    contractRef: booking.detail['contractRef'] ?? '',
    asOf,
    correlationId,
  });
  if (!read.ok) return read;
  if (read.value.kind !== 'ANSWERED')
    return fail('RAIL_UNAVAILABLE', 'The loan system did not give the loan’s position', {
      rail: 'CORE_BANKING',
      reason: read.value.kind === 'REFUSED' ? read.value.code : read.value.reason,
    });
  return ok({ position: read.value.value, source: system.source });
}

/**
 * Record a collection's result from its rail. Exactly once per collection: a second result for the same
 * collection is ignored. Settled money is posted into the loan system on the next servicing run.
 */
export async function recordCollectionResult(
  pool: Pool,
  tenant: TenantCode,
  p: {
    readonly loanRef: string;
    readonly collectionKey: string;
    readonly outcome: 'SETTLED' | 'RETURNED';
    readonly settlementRef: string;
    readonly valueDate: string;
    readonly source: 'LIVE' | 'FIXTURE';
    readonly reason?: string;
  },
  actor: string,
): Promise<Result<CoreHeldLoanEvent>> {
  const [view] = await listConsumerLoans(pool, tenant, p.loanRef);
  if (view === undefined) return fail('LOAN_NOT_FOUND', 'No consumer loan with this reference', { loanRef: p.loanRef });
  const queued = view.events.find((e) => e.kind === 'COLLECTION_QUEUED' && e.idempotencyKey === p.collectionKey);
  if (queued === undefined) return fail('COLLECTION_NOT_FOUND', 'No queued collection with this key');
  const already = view.events.find(
    (e) =>
      (e.kind === 'COLLECTION_SETTLED' || e.kind === 'COLLECTION_RETURNED') &&
      e.detail['collectionKey'] === p.collectionKey,
  );
  if (already !== undefined) return ok(already);
  if (!DATE.test(p.valueDate)) return fail('VALUE_DATE_INVALID', 'The value date is yyyy-mm-dd');
  const event: CoreHeldLoanEvent = {
    kind: p.outcome === 'SETTLED' ? 'COLLECTION_SETTLED' : 'COLLECTION_RETURNED',
    ...(queued.scheduleNumber === undefined ? {} : { scheduleNumber: queued.scheduleNumber }),
    idempotencyKey: `${p.collectionKey}:result`,
    detail: {
      collectionKey: p.collectionKey,
      settlementRef: p.settlementRef,
      valueDate: p.valueDate,
      minorUnits: queued.detail['minorUnits'] ?? '0',
      currency: queued.detail['currency'] ?? view.loan.currency,
      source: p.source,
      ...(p.reason === undefined ? {} : { reason: p.reason }),
    },
  };
  await recordLoanEvents(pool, tenant, p.loanRef, [event], actor, view.loan.correlationId);
  return ok(event);
}

async function appendOutbox(pool: Pool, tenant: TenantCode, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const uuid = await tenantUuidByCode(pool, tenant);
  await postgresOutboxStore(pool).append(events.map((e) => ({ ...e, tenantId: uuid })));
}

/**
 * Service the loan for `asOf`. `simulateRailResults` stands in for the rails' answers in a synthetic
 * demonstration only: a mandate reference containing `insufficient` or `reject` is returned, any other settles.
 */
export async function runConsumerLoanServicing(
  pool: Pool,
  tenant: TenantCode,
  loanRef: string,
  asOf: string,
  actor: string,
  opts: { readonly simulateRailResults: boolean },
): Promise<Result<ServicingRun>> {
  if (!DATE.test(asOf)) return fail('AS_OF_INVALID', 'The servicing date is yyyy-mm-dd');
  if (opts.simulateRailResults && !(await syntheticDemonstrationPermitted(pool)))
    return fail('FIXTURE_NOT_PERMITTED', 'Rail results are simulated only in a synthetic demonstration');
  const booked = await bookConsumerLoan(pool, tenant, loanRef, actor);
  if (!booked.ok) return booked;
  const policy = loadOriginationPolicy(tenant);
  const maxAttempts = policy.ok ? policy.value.servicingRetry.maxAttempts : 3;
  const correlationId = randomUUID();
  let posted = 0;
  let queuedCount = 0;
  let settled = 0;
  let returned = 0;
  let overdueCount = 0;
  let closed = false;

  // Two passes at most: post what settled, collect what is due; with simulated results, post those too.
  for (let pass = 0; pass < 2; pass += 1) {
    const c = await context(pool, tenant, loanRef);
    if (!c.ok) return c;
    const { view, system } = c.value;
    const booking = bookingOf(view);
    if (booking === undefined) return fail('LOAN_NOT_BOOKED', 'The loan is not booked in the loan system yet');
    const l = view.loan;
    const servicingAccountRef = booking.detail['servicingAccountRef'] ?? '';

    // 1. Post settled collections into the servicing account.
    const first = await readPosition(system, tenant, booking, asOf, l.correlationId);
    if (!first.ok) return first;
    const pre = planServicing(l, view.events, first.value.position, maxAttempts);
    for (const p of pre.postings) {
      const r = await system.postRepayment({
        tenantId: tenant,
        contractRef: booking.detail['contractRef'] ?? '',
        servicingAccountRef,
        amount: p.received,
        settlementRef: p.settlementRef,
        valueDate: p.valueDate,
        idempotencyKey: p.idempotencyKey,
        correlationId: l.correlationId,
      });
      if (!r.ok) return r;
      if (r.value.kind !== 'ANSWERED')
        return fail(
          'RAIL_UNAVAILABLE',
          'The loan system did not take the repayment; try again: posting is idempotent',
          {
            rail: 'CORE_BANKING',
          },
        );
      await recordLoanEvents(
        pool,
        tenant,
        l.loanRef,
        [
          {
            kind: 'REPAYMENT_POSTED',
            scheduleNumber: p.scheduleNumber,
            idempotencyKey: p.idempotencyKey,
            detail: {
              collectionKey: p.collectionKey,
              transactionRef: r.value.value.transactionRef,
              minorUnits: p.received.minorUnits.toString(),
              currency: p.received.currency,
              source: system.source,
            },
          },
        ],
        actor,
        correlationId,
      );
      posted += 1;
    }

    // 2. With postings reflected, decide collections, overdue reports and closure.
    const after = await listConsumerLoans(pool, tenant, loanRef);
    const events = after[0]?.events ?? view.events;
    const now = await readPosition(system, tenant, booking, asOf, l.correlationId);
    if (!now.ok) return now;
    const plan = planServicing(l, events, now.value.position, maxAttempts);
    // The second pass only posts what settled in the first: a collection returned today is retried on a later run.
    const collect = pass === 0 ? plan.collections : [];
    const kind = collectionEventKind(l.collectionChannel);
    const outbox: OutboxEvent[] = [];
    const recorded: CoreHeldLoanEvent[] = [];
    const base = { tenantId: tenant, subjectRef: l.loanRef, correlationId };
    if (kind !== undefined)
      for (const col of collect) {
        const amountFields = { minorUnits: col.due.minorUnits.toString(), currency: col.due.currency };
        outbox.push({
          ...base,
          eventId: col.idempotencyKey,
          kind,
          idempotencyKey: col.idempotencyKey,
          payload:
            kind === 'BILL_PRESENT'
              ? { payerRef: l.collectionMandateRef, dueDateGregorian: col.dueDate, ...amountFields }
              : kind === 'PAYMENT_INITIATE'
                ? { payerRef: l.applicantRef, consentId: l.collectionMandateRef, ...amountFields }
                : { payerRef: l.collectionMandateRef, channel: l.collectionChannel, ...amountFields },
        });
        recorded.push({
          kind: 'COLLECTION_QUEUED',
          scheduleNumber: col.scheduleNumber,
          idempotencyKey: col.idempotencyKey,
          detail: {
            channel: l.collectionChannel,
            eventKind: kind,
            dueDate: col.dueDate,
            attemptNumber: String(col.attemptNumber),
            ...amountFields,
          },
        });
      }
    for (const o of plan.overdue) {
      const key = `loan:${l.loanRef}:overdue:I${String(o.scheduleNumber)}`;
      const amountFields = { minorUnits: o.outstanding.minorUnits.toString(), currency: o.outstanding.currency };
      outbox.push(
        {
          ...base,
          eventId: `${key}:bureau`,
          kind: 'BUREAU_REPORT',
          idempotencyKey: `${key}:bureau`,
          payload: { facilityRef: l.loanRef, event: 'ARREARS', daysPastDue: String(o.daysPastDue), ...amountFields },
        },
        {
          ...base,
          eventId: `${key}:notice`,
          kind: 'NOTIFICATION',
          idempotencyKey: `${key}:notice`,
          payload: {
            recipientKind: 'COUNTERPARTY',
            recipientRef: l.applicantRef,
            event: 'INSTALMENT_OVERDUE',
            channels: 'SMS',
            loanRef: l.loanRef,
            scheduleNumber: String(o.scheduleNumber),
            ...amountFields,
          },
        },
      );
      recorded.push({
        kind: 'INSTALMENT_OVERDUE',
        scheduleNumber: o.scheduleNumber,
        idempotencyKey: key,
        detail: { daysPastDue: String(o.daysPastDue), ...amountFields },
      });
    }
    if (plan.close) {
      const key = `loan:${l.loanRef}:closed`;
      outbox.push({
        ...base,
        eventId: `${key}:bureau`,
        kind: 'BUREAU_REPORT',
        idempotencyKey: `${key}:bureau`,
        payload: { facilityRef: l.loanRef, event: 'CLOSED', minorUnits: '0', currency: l.currency },
      });
      recorded.push({ kind: 'LOAN_CLOSED', idempotencyKey: key, detail: { asOf } });
    }
    // The effects first, durably, then what Sanad records of them: a rerun re-queues nothing (both idempotent).
    await appendOutbox(pool, tenant, outbox);
    await recordLoanEvents(pool, tenant, l.loanRef, recorded, actor, correlationId);
    queuedCount += collect.length;
    overdueCount += plan.overdue.length;
    closed = closed || plan.close || now.value.position.closed;

    // 3. In a demonstration, the fixture rails answer at once; the second pass posts what settled.
    if (!opts.simulateRailResults || collect.length === 0) {
      return ok({
        loanRef,
        source: now.value.source,
        asOf,
        position: now.value.position,
        booked: true,
        posted,
        queued: queuedCount,
        settled,
        returned,
        overdue: overdueCount,
        closed,
      });
    }
    for (const col of collect) {
      const refused = /insufficient|reject/i.test(l.collectionMandateRef);
      const r = await recordCollectionResult(
        pool,
        tenant,
        {
          loanRef,
          collectionKey: col.idempotencyKey,
          outcome: refused ? 'RETURNED' : 'SETTLED',
          settlementRef: `FIXTURE-${col.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`,
          valueDate: asOf,
          source: 'FIXTURE',
          ...(refused ? { reason: 'INSUFFICIENT_FUNDS' } : {}),
        },
        actor,
      );
      if (!r.ok) return r;
      if (refused) returned += 1;
      else settled += 1;
    }
  }
  const final = await consumerLoanPosition(pool, tenant, loanRef, asOf);
  if (!final.ok) return final;
  return ok({
    loanRef,
    source: final.value.source,
    asOf,
    position: final.value.position,
    booked: true,
    posted,
    queued: queuedCount,
    settled,
    returned,
    overdue: overdueCount,
    closed: closed || final.value.position.closed,
  });
}
