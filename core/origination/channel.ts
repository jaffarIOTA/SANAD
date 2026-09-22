/**
 * Origination channels.
 *
 * A drawdown can be initiated four ways: keyed internally by an operator,
 * raised by the counterparty in its own portal, posted by a partner system
 * over the API, or nominated by an aggregator on behalf of a merchant it
 * serves.
 *
 * **The channel changes who may initiate and what is retained as evidence of
 * the instruction. It changes nothing about the sequencing.** Every channel
 * converges on the same transaction aggregate and the same three gates: a
 * partner posting over an API does not get a shorter path to a sale leg than
 * an operator keying it by hand, and an aggregator with a commercial
 * relationship does not get a softer evidence requirement. There is one state
 * machine and it does not know which door the request came through.
 *
 * That property is asserted by test, because it is precisely the thing that
 * erodes: a high-volume integration partner asks for "a faster path", and
 * unless the faster path is structurally the same path, it becomes a way
 * round the gates.
 */

import { type Result, ok, reject } from '../kernel/result.ts';

export type OriginationChannel =
  /** Keyed by an operator inside the institution; a second operator approves. */
  | 'MAKER_CHECKER'
  /** Raised by the counterparty in its own portal. */
  | 'COUNTERPARTY_SELF'
  /** Posted by an integrating system under its own credential. */
  | 'PARTNER_API'
  /** Nominated by an aggregator on behalf of a merchant in its network. */
  | 'EMBEDDED_AGGREGATOR';

export const ORIGINATION_CHANNELS: readonly OriginationChannel[] = [
  'MAKER_CHECKER',
  'COUNTERPARTY_SELF',
  'PARTNER_API',
  'EMBEDDED_AGGREGATOR',
];

/**
 * How the party that initiated the request was identified.
 *
 * Retained on the request because "who asked for this" is the first question
 * in any dispute, and the answer differs sharply by channel: an operator is an
 * authenticated staff principal, an aggregator is a machine identity acting
 * for a merchant who is not present.
 */
export type InitiatorIdentification =
  | { readonly kind: 'STAFF_PRINCIPAL'; readonly principalId: string }
  | { readonly kind: 'VERIFIED_SIGNATORY'; readonly assertionId: string }
  | { readonly kind: 'PARTNER_SYSTEM'; readonly partnerId: string; readonly credentialRef: string }
  | {
      readonly kind: 'AGGREGATOR_ON_BEHALF';
      readonly aggregatorId: string;
      readonly credentialRef: string;
      /** The merchant's own consent to be nominated. Not the aggregator's. */
      readonly merchantMandateRef: string;
    };

export interface ChannelPolicy {
  readonly channel: OriginationChannel;
  /**
   * Whether the servicing platform is consulted before a human reviews the
   * request.
   *
   * Two stages, in order: the servicing platform responds on limits, exposure
   * and account standing, and the institution then decides with that answer in
   * front of it. The servicing response is an input to the decision, never the
   * decision itself — and emphatically not a sequencing gate. A platform that
   * says yes has told us about credit capacity; it has said nothing about
   * whether goods were bought, possessed and held at risk.
   */
  readonly requiresServicingDecision: boolean;
  /**
   * Whether a second, different principal must approve before the request
   * becomes a transaction. This governs the *request*, never a gate.
   */
  readonly requiresFourEyes: boolean;
  /** Identification kinds this channel may present. */
  readonly acceptableIdentification: readonly InitiatorIdentification['kind'][];
  /**
   * Where a third party initiates on someone else's behalf, we hold a mandate
   * from the party who will owe the money — not from the party who introduced
   * them. An aggregator's commercial interest is not the merchant's consent.
   */
  readonly requiresMerchantMandate: boolean;
}

export const CHANNEL_POLICIES: Readonly<Record<OriginationChannel, ChannelPolicy>> = {
  MAKER_CHECKER: {
    channel: 'MAKER_CHECKER',
    requiresServicingDecision: false,
    requiresFourEyes: true,
    acceptableIdentification: ['STAFF_PRINCIPAL'],
    requiresMerchantMandate: false,
  },
  COUNTERPARTY_SELF: {
    channel: 'COUNTERPARTY_SELF',
    requiresServicingDecision: false,
    requiresFourEyes: false,
    acceptableIdentification: ['VERIFIED_SIGNATORY'],
    requiresMerchantMandate: false,
  },
  PARTNER_API: {
    channel: 'PARTNER_API',
    // An external system asked. The institution's own platform answers before
    // anyone signs anything off.
    requiresServicingDecision: true,
    requiresFourEyes: false,
    acceptableIdentification: ['PARTNER_SYSTEM'],
    requiresMerchantMandate: false,
  },
  EMBEDDED_AGGREGATOR: {
    channel: 'EMBEDDED_AGGREGATOR',
    requiresServicingDecision: true,
    // Someone who is not the borrower is asking for credit in the borrower's
    // name. A second pair of eyes is the least of it.
    requiresFourEyes: true,
    acceptableIdentification: ['AGGREGATOR_ON_BEHALF'],
    requiresMerchantMandate: true,
  },
};

export function verifyIdentification(
  channel: OriginationChannel,
  identification: InitiatorIdentification,
): Result<true> {
  const policy = CHANNEL_POLICIES[channel];

  if (!policy.acceptableIdentification.includes(identification.kind)) {
    return reject(
      'OP-DETERMINACY',
      'IDENTIFICATION_NOT_ACCEPTABLE_FOR_CHANNEL',
      'The initiator was not identified in a way this channel accepts',
      { channel, presented: identification.kind },
    );
  }

  if (policy.requiresMerchantMandate) {
    if (identification.kind !== 'AGGREGATOR_ON_BEHALF') {
      return reject(
        'OP-DETERMINACY',
        'MERCHANT_MANDATE_MISSING',
        'This channel requires a mandate from the party who will owe the money',
        { channel },
      );
    }
    if (identification.merchantMandateRef.trim().length === 0) {
      return reject(
        'OP-DETERMINACY',
        'MERCHANT_MANDATE_EMPTY',
        'An aggregator may introduce a merchant; it may not consent on the merchant’s behalf',
        { channel, aggregatorId: identification.aggregatorId },
      );
    }
  }

  return ok(true);
}
