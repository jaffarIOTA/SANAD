/**
 * Domain to wire, and back.
 *
 * Kept in one file so there is a single place to check that nothing leaks.
 * Two things are deliberately *not* carried outward:
 *
 * **Internal staff identity.** Who keyed and who approved a request is
 * recorded in full and is available to the Board's audit workspace. A partner
 * has no business with it, so `maker`, `checker` and `reviewer` never appear
 * in a response.
 *
 * **Anything rate-shaped.** There is nothing to omit, because the domain has
 * no such field — but the mapper is written field by field rather than by
 * spreading the aggregate, so a field added to the domain does not appear on
 * the wire without someone deciding it should.
 */

import type {
  OriginationRequest,
  OriginationRequestCore,
} from '@sanad/core/origination/request.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

export interface AttestedInstantWire {
  readonly instant: string;
  readonly attestationRef: string;
}

export function attested(instant: TsaInstant): AttestedInstantWire {
  return {
    instant: new Date(Number(instant.epochSeconds) * 1000).toISOString(),
    attestationRef: instant.tokenDigest,
  };
}

export interface TradeReferenceWire {
  readonly type: 'CLEARED_INVOICE' | 'PURCHASE_ORDER';
  readonly invoiceUuid?: string;
  readonly invoiceHash?: string;
  readonly issuerCr: string;
  readonly recipientCr: string;
}

export interface MoneyWire {
  readonly minorUnits: string;
  readonly currency: 'SAR';
}

export interface OriginationRequestWire {
  readonly requestId: string;
  readonly state: string;
  readonly channel: string;
  readonly programmeId: string;
  readonly counterpartyId: string;
  readonly tradeReference: TradeReferenceWire;
  readonly requestedAmount: MoneyWire;
  readonly requestedTenorDays: number;
  readonly raisedAt: AttestedInstantWire;
  readonly correlationId: string;
  readonly partnerReference?: string;
  readonly servicing?: {
    readonly decision: string;
    readonly reference: string;
    readonly reasonCode?: string;
    readonly respondedAt: AttestedInstantWire;
  };
  readonly outcome?: {
    readonly decidedAt: AttestedInstantWire;
    readonly reasonCode?: string;
    readonly note?: string;
  };
  readonly transaction?: { readonly transactionId: string; readonly state: 'DRAFT' };
}

function tradeReference(core: OriginationRequestCore): TradeReferenceWire {
  const trade = core.tradeReference;
  return {
    type: trade.type,
    ...(trade.invoiceUuid === undefined ? {} : { invoiceUuid: trade.invoiceUuid }),
    ...(trade.invoiceHash === undefined ? {} : { invoiceHash: trade.invoiceHash }),
    issuerCr: trade.issuerCr,
    recipientCr: trade.recipientCr,
  };
}

export function toWire(
  request: OriginationRequest,
  partnerReference: string | undefined,
): OriginationRequestWire {
  const core = request.core;

  const servicing =
    'servicing' in request && request.servicing !== undefined
      ? {
          decision: request.servicing.decision,
          reference: request.servicing.reference,
          ...(request.servicing.reasonCode === undefined
            ? {}
            : { reasonCode: request.servicing.reasonCode }),
          respondedAt: attested(request.servicing.respondedAt),
        }
      : undefined;

  const outcome =
    request.state === 'APPROVED'
      ? { decidedAt: attested(request.approvedAt) }
      : request.state === 'RETURNED_TO_MAKER'
        ? // A returned request has no attested decision instant in the domain
          // today; the note is the substance and is carried alone rather than
          // inventing a timestamp for the shape's sake.
          undefined
        : undefined;

  return {
    requestId: core.requestId,
    state: request.state,
    channel: core.channel,
    programmeId: core.programmeId,
    counterpartyId: core.counterpartyId,
    tradeReference: tradeReference(core),
    requestedAmount: {
      minorUnits: core.requestedAmount.minorUnits.toString(),
      currency: core.requestedAmount.currency as 'SAR',
    },
    requestedTenorDays: core.requestedTenorDays,
    raisedAt: attested(core.raisedAt),
    correlationId: core.correlationId,
    ...(partnerReference === undefined ? {} : { partnerReference }),
    ...(servicing === undefined ? {} : { servicing }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(request.state === 'RETURNED_TO_MAKER' ? { outcome: { note: request.note } } : {}),
    ...(request.state === 'REJECTED' ? { outcome: { reasonCode: request.reasonCode } } : {}),
  } as OriginationRequestWire;
}

/** The body a partner sends to raise a request. Shape already validated. */
export interface RaiseRequestBody {
  readonly programmeId: string;
  readonly counterpartyId: string;
  readonly tradeReference: TradeReferenceWire;
  readonly requestedAmount: MoneyWire;
  readonly requestedTenorDays: number;
  readonly initiator:
    | { readonly kind: 'PARTNER_SYSTEM' }
    | { readonly kind: 'AGGREGATOR_ON_BEHALF'; readonly merchantMandateRef: string };
  readonly partnerReference?: string;
}
