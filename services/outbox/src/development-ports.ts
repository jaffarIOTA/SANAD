/**
 * Development ports for the dispatcher: every rail answers as a rail would,
 * and what it "did" is written to a ledger the workbench can show. Nothing
 * leaves the process. Replaced port by port as the adapters go live.
 */

import { type Result, ok } from '../../../core/kernel/result.ts';
import type { DispatchPorts } from '../../../core/outbox/dispatch.ts';

export interface DevelopmentDelivery {
  readonly port: string;
  readonly idempotencyKey: string;
  readonly summary: string;
}

export function developmentDispatchPorts(
  ledger: DevelopmentDelivery[],
  options: { readonly unavailable?: ReadonlySet<string> } = {},
): DispatchPorts {
  const down = (port: string) => options.unavailable?.has(port) === true;
  const record = (port: string, idempotencyKey: string, summary: string): void => {
    ledger.push({ port, idempotencyKey, summary });
  };
  let n = 0;
  const ref = (prefix: string) => `${prefix}-dev-${String(++n)}`;
  return {
    payments: {
      disburse: (p) => {
        if (down('payments'))
          return Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'development: payments hub down' }));
        record(
          'payments.disburse',
          p.idempotencyKey,
          `${p.amount.minorUnits.toString()} ${p.amount.currency} to ${p.beneficiaryRef}`,
        );
        return Promise.resolve(
          ok({
            kind: 'ANSWERED' as const,
            value: { instructionRef: ref('pay'), status: 'ACCEPTED' as const, acceptedAtEpochSeconds: 0n },
          }),
        );
      },
      collect: (p) => {
        record('payments.collect', p.idempotencyKey, `${p.amount.minorUnits.toString()} from ${p.payerRef}`);
        return Promise.resolve(
          ok({
            kind: 'ANSWERED' as const,
            value: { instructionRef: ref('col'), status: 'ACCEPTED' as const, acceptedAtEpochSeconds: 0n },
          }),
        );
      },
    },
    bureau: {
      request: () => Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'development: not a query port' })),
      report: (r) => {
        if (down('bureau'))
          return Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'development: bureau down' }));
        record('bureau.report', r.idempotencyKey, `${r.event} ${r.facilityRef}`);
        return Promise.resolve(ok({ kind: 'ACKNOWLEDGED' as const, acknowledgementRef: ref('ack') }));
      },
    },
    webhooks: {
      deliver: (d) => {
        if (down('webhooks'))
          return Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'development: partner endpoint down' }));
        record('webhooks.deliver', d.idempotencyKey, `${d.event} → ${d.partnerRef}`);
        return Promise.resolve(ok({ kind: 'ANSWERED' as const, value: { deliveryRef: ref('whk'), statusCode: 204 } }));
      },
    },
    notifications: {
      send: (n): Promise<Result<{ readonly deliveryRef: string }>> => {
        record('notifications.send', n.dedupeKey, `${n.event} → ${n.recipient.kind}`);
        return Promise.resolve(ok({ deliveryRef: ref('ntf') }));
      },
    },
    bills: {
      present: (b) => {
        record('bills.present', b.idempotencyKey, `${b.amount.minorUnits.toString()} due ${b.dueDateGregorian}`);
        return Promise.resolve(
          ok({ kind: 'ANSWERED' as const, value: { billRef: ref('bill'), presentedAtEpochSeconds: 0n } }),
        );
      },
      paid: () => Promise.resolve(ok({ kind: 'ANSWERED' as const, value: [] })),
    },
  };
}
