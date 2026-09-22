/**
 * Adversarial compliance — origination intake.
 *
 * The headline property: **whichever door a request comes through, it lands at
 * the same place.** A checker's approval, a partner's API call and an
 * aggregator's nomination all produce a transaction in `DRAFT`, at the very
 * start of the sequence, with all three gates still ahead of it.
 *
 * That is the thing under pressure in a real programme. A high-volume
 * integration partner asks for a faster path; an operations lead asks whether
 * an approved request can just be booked. Both are reasonable-sounding
 * requests and both are the same request: a way round the gates. These tests
 * exist so the answer is a build failure rather than a conversation.
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_POLICIES,
  ORIGINATION_CHANNELS,
  type InitiatorIdentification,
  type OriginationChannel,
  verifyIdentification,
} from '../../core/origination/channel.ts';
import {
  type OriginationRequestCore,
  type Principal,
  approve,
  openTransaction,
  raise,
  rejectRequest,
  returnToMaker,
  submitForReview,
} from '../../core/origination/request.ts';
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { ANCHOR_CR, INSTITUTION_CR, at, transactionCore } from '../support/fixtures.ts';

const MAKER: Principal = { principalId: 'stf-maker', tenantId: 'bank-a' };
const CHECKER: Principal = { principalId: 'stf-checker', tenantId: 'bank-a' };

const INVOICE_UUID = '3cf5d9a2-0000-4000-8000-000000000001';

const IDENTIFICATION: Readonly<Record<OriginationChannel, InitiatorIdentification>> = {
  MAKER_CHECKER: { kind: 'STAFF_PRINCIPAL', principalId: MAKER.principalId },
  COUNTERPARTY_SELF: { kind: 'VERIFIED_SIGNATORY', assertionId: 'asr-0001' },
  PARTNER_API: { kind: 'PARTNER_SYSTEM', partnerId: 'ptr-0001', credentialRef: 'cred-0001' },
  EMBEDDED_AGGREGATOR: {
    kind: 'AGGREGATOR_ON_BEHALF',
    aggregatorId: 'agg-0001',
    credentialRef: 'cred-0002',
    merchantMandateRef: 'mdt-0001',
  },
};

function requestCore(channel: OriginationChannel): OriginationRequestCore {
  return {
    requestId: `req-${channel}`,
    tenantId: 'bank-a',
    programmeId: 'prg-0001',
    counterpartyId: 'cpt-0001',
    channel,
    identification: IDENTIFICATION[channel],
    tradeReference: {
      type: 'CLEARED_INVOICE',
      invoiceUuid: INVOICE_UUID,
      invoiceHash: 'invoice-hash',
      issuerCr: ANCHOR_CR,
      recipientCr: INSTITUTION_CR,
    },
    requestedAmount: money(18_500_000n),
    requestedTenorDays: 90,
    correlationId: 'cor-0001',
    raisedAt: at(1_000_000),
  };
}

function approvedRequest(channel: OriginationChannel) {
  const keyed = expectOk(raise({ core: requestCore(channel), maker: MAKER }));
  const submitted = expectOk(submitForReview(keyed, at(1_000_050)));
  return expectOk(approve(submitted, CHECKER, at(1_000_100)));
}

describe.each(ORIGINATION_CHANNELS)('adversarial: origination via %s', (channel) => {
  it('lands at the start of the sequence, not part-way through it', () => {
    const approvalGivesADraft = openTransaction(
      approvedRequest(channel),
      transactionCore('bank-a'),
    );

    const draft = expectOk(approvalGivesADraft);

    // The whole point. An approval is worth exactly one state: the first one.
    expect(draft.state).toBe('DRAFT');
  });

  it('exposes no way to open a transaction in any later state', async () => {
    const module = await import('../../core/origination/request.ts');
    const approved = approvedRequest(channel);

    // Every exported function that accepts an approval returns a DRAFT or a
    // rejection. There is no `openExecuted`, no `bookDirectly`, no options bag
    // with a target state.
    const openers = Object.entries(module).filter(
      ([name]) => /^(open|convert|book|execute|promote)/i.test(name),
    );
    expect(openers.map(([name]) => name)).toEqual(['openTransaction']);

    const result = module.openTransaction(approved, transactionCore('bank-a'));
    expect(expectOk(result).state).toBe('DRAFT');
  });

  it('refuses identification the channel does not accept', () => {
    for (const other of ORIGINATION_CHANNELS) {
      const result = verifyIdentification(channel, IDENTIFICATION[other]);
      const acceptable = CHANNEL_POLICIES[channel].acceptableIdentification.includes(
        IDENTIFICATION[other].kind,
      );
      expect(result.ok, `${channel} given ${other} identification`).toBe(acceptable);
    }
  });

  it('refuses a request for a non-positive amount', () => {
    const result = raise({
      core: { ...requestCore(channel), requestedAmount: money(0n) },
      maker: MAKER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-03');
  });

  it('refuses a request whose trade is swapped after approval', () => {
    // The approved trade and the executed trade must be the same trade,
    // otherwise four eyes reviewed one thing and the system opened another.
    const substituted = {
      ...transactionCore('bank-a'),
      tradeReference: {
        ...transactionCore('bank-a').tradeReference,
        invoiceUuid: '00000000-0000-4000-8000-000000000999',
      },
    };

    const result = openTransaction(approvedRequest(channel), substituted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-10');
    expect(result.error.reason).toBe('TRADE_REFERENCE_SUBSTITUTED');
  });

  it('refuses a principal acting across a tenant boundary', () => {
    const result = raise({
      core: requestCore(channel),
      maker: { principalId: 'stf-elsewhere', tenantId: 'fintech-b' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('adversarial: four eyes', () => {
  it('refuses the maker approving their own request', () => {
    const keyed = expectOk(raise({ core: requestCore('MAKER_CHECKER'), maker: MAKER }));
    const submitted = expectOk(submitForReview(keyed, at(1_000_050)));

    const result = approve(submitted, MAKER, at(1_000_100));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('FOUR_EYES_VIOLATED');
  });

  it('refuses it on the embedded channel too, where someone else is borrowing', () => {
    const keyed = expectOk(raise({ core: requestCore('EMBEDDED_AGGREGATOR'), maker: MAKER }));
    const submitted = expectOk(submitForReview(keyed, at(1_000_050)));

    expect(approve(submitted, MAKER, at(1_000_100)).ok).toBe(false);
    expect(approve(submitted, CHECKER, at(1_000_100)).ok).toBe(true);
  });

  it('requires a mandate from the party who will owe the money', () => {
    // An aggregator may introduce a merchant. It may not consent for them.
    const result = verifyIdentification('EMBEDDED_AGGREGATOR', {
      kind: 'AGGREGATOR_ON_BEHALF',
      aggregatorId: 'agg-0001',
      credentialRef: 'cred-0002',
      merchantMandateRef: '   ',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('MERCHANT_MANDATE_EMPTY');
  });

  it('refuses a return to maker with no explanation', () => {
    const keyed = expectOk(raise({ core: requestCore('MAKER_CHECKER'), maker: MAKER }));
    const submitted = expectOk(submitForReview(keyed, at(1_000_050)));

    expect(returnToMaker(submitted, CHECKER, '  ').ok).toBe(false);
    expect(returnToMaker(submitted, CHECKER, 'Delivery note is illegible').ok).toBe(true);
  });

  it('refuses a rejection with no reason code', () => {
    const keyed = expectOk(raise({ core: requestCore('MAKER_CHECKER'), maker: MAKER }));
    const submitted = expectOk(submitForReview(keyed, at(1_000_050)));

    expect(rejectRequest(submitted, CHECKER, '').ok).toBe(false);
    expect(rejectRequest(submitted, CHECKER, 'R_GOODS_NOT_ELIGIBLE').ok).toBe(true);
  });
});

describe('the channel changes the door, never the gates', () => {
  it('every channel produces an identical transaction state', () => {
    const states = ORIGINATION_CHANNELS.map((channel) =>
      expectOk(openTransaction(approvedRequest(channel), transactionCore('bank-a'))).state,
    );
    expect(new Set(states)).toEqual(new Set(['DRAFT']));
  });

  it('no channel policy can turn off four eyes where a third party is borrowing', () => {
    expect(CHANNEL_POLICIES.EMBEDDED_AGGREGATOR.requiresFourEyes).toBe(true);
    expect(CHANNEL_POLICIES.EMBEDDED_AGGREGATOR.requiresMerchantMandate).toBe(true);
  });

  it('the intake module names no sequencing transition', async () => {
    const module = await import('../../core/origination/request.ts');
    const { SEQUENCING_TRANSITIONS } = await import('../../core/authz/entitlements.ts');

    for (const transition of SEQUENCING_TRANSITIONS) {
      expect(Object.keys(module)).not.toContain(transition);
    }
  });
});
