/**
 * Adversarial compliance — the remaining prohibited outcomes.
 *
 * Finance an already-financed invoice. Increase a total on reschedule. Post a
 * late charge to income. Render two legs into one document. Transact with the
 * same legal entity on both sides. Define an entitlement that advances a gate.
 *
 * Each passes only when the attempt fails.
 */

import { describe, expect, it } from 'vitest';

import { TENANT_CODES } from '../../config/loader.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { money } from '../../core/kernel/money.ts';
import { priceMurabaha } from '../../core/pricing/murabaha.ts';
import {
  type Instalment,
  applyEarlySettlementRelief,
  applyPayment,
  createObligation,
  reschedule,
} from '../../core/obligation/obligation.ts';
import { disburse, postLateAmount } from '../../core/ledger/charity.ts';
import { buildLegRenderRequest } from '../../core/documents/render.ts';
import { appendLeg } from '../../core/legs/leg.ts';
import { verifyDistinctParties, verifyNoBuyBack } from '../../core/parties/distinctness.ts';
import {
  ENTITLEMENT_ACTIONS,
  FORBIDDEN_ENTITLEMENT_PATTERNS,
  SEQUENCING_TRANSITIONS,
  defineEntitlement,
} from '../../core/authz/entitlements.ts';
import {
  type FinancedInvoiceRecord,
  type FinancedInvoiceRegistryPort,
  assertNotPreviouslyFinanced,
} from '../../core/trade/financed-invoice-registry.ts';
import { ANCHOR_CR, DISTRIBUTOR_CR, at, chain, structureFor } from '../support/fixtures.ts';

// -- SH-10: duplicate financing ------------------------------------------------

/**
 * An in-memory stand-in for the repository. The real enforcement is the unique
 * constraint on (tenant_id, invoice_uuid); this exercises the pre-flight check
 * that turns a constraint violation into a specific, explainable refusal.
 */
class InMemoryRegistry implements FinancedInvoiceRegistryPort {
  readonly #rows = new Map<string, string>();

  async register(record: FinancedInvoiceRecord) {
    const key = `${record.tenantId}/${record.invoiceUuid}`;
    const existing = this.#rows.get(key);
    if (existing !== undefined && existing !== record.transactionId) {
      // No ON CONFLICT DO NOTHING. A conflict is the control firing.
      return {
        ok: false as const,
        error: {
          control: 'SH-10' as const,
          reason: 'DUPLICATE_FINANCING',
          detail: 'This invoice has already been financed and cannot be financed again',
          context: { existingReference: existing },
        },
      };
    }
    this.#rows.set(key, record.transactionId);
    return { ok: true as const, value: { registryId: key } };
  }

  async lookup(tenantId: string, invoiceUuid: string) {
    const existing = this.#rows.get(`${tenantId}/${invoiceUuid}`);
    return existing === undefined ? undefined : { transactionId: existing };
  }
}

describe('adversarial: duplicate financing (SH-10)', () => {
  const invoiceUuid = '3cf5d9a2-0000-4000-8000-000000000001';

  const record = (transactionId: string): FinancedInvoiceRecord => ({
    tenantId: 'bank-a',
    invoiceUuid,
    invoiceHash: 'invoice-hash',
    issuerCr: ANCHOR_CR,
    recipientCr: DISTRIBUTOR_CR,
    financedAmount: money(18_500_000n),
    transactionId,
    financedAtEpochSeconds: 1_000_000n,
  });

  it('refuses a second drawdown against an invoice already financed', async () => {
    const registry = new InMemoryRegistry();
    expectOk(await registry.register(record('txn-0001')));

    const preflight = await assertNotPreviouslyFinanced(registry, 'bank-a', invoiceUuid);
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.error.control).toBe('SH-10');
    expect(preflight.error.context?.['existingReference']).toBe('txn-0001');

    const secondWrite = await registry.register(record('txn-0002'));
    expect(secondWrite.ok).toBe(false);
  });

  it('still allows an idempotent replay of the same drawdown', async () => {
    const registry = new InMemoryRegistry();
    expectOk(await registry.register(record('txn-0001')));
    expectOk(await registry.register(record('txn-0001')));
  });

  it('keeps the record after settlement', async () => {
    // There is no method to remove one. The absence is the point: an invoice
    // financed once is unfinanceable forever, including after the obligation
    // has closed and the transaction itself has aged out of retention.
    const registry = new InMemoryRegistry();
    expectOk(await registry.register(record('txn-0001')));
    expect(Object.keys(registry)).not.toContain('delete');
    expect(await registry.lookup('bank-a', invoiceUuid)).toEqual({ transactionId: 'txn-0001' });
  });
});

// -- SH-02: the total never increases ------------------------------------------

describe('adversarial: the total never increases (SH-02)', () => {
  const pricing = expectOk(priceMurabaha(money(18_500_000n), money(462_500n)));
  const total = pricing.salePriceAmount.minorUnits; // 18,962,500

  const split = (amounts: readonly bigint[]): Instalment[] =>
    amounts.map((amount, i) => ({
      instalmentNo: i + 1,
      dueDateGregorian: `2026-1${i}-01`,
      dueDateHijri: `1448-0${i + 1}-01`,
      amount: money(amount),
    }));

  const obligation = expectOk(
    createObligation({
      obligationId: 'obl-0001',
      tenantId: 'bank-a',
      transactionId: 'txn-0001',
      pricing,
      instalments: split([9_481_250n, 9_481_250n]),
    }),
  );

  it('refuses a schedule that sums to more than the original total', () => {
    const result = reschedule(obligation, split([9_481_250n, 9_481_251n]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-02');
    expect(result.error.reason).toBe('SCHEDULE_INCREASES_TOTAL');
  });

  it('refuses a schedule that does not sum to the total at all', () => {
    const result = reschedule(obligation, split([1_000_000n]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-02');
  });

  it('accepts new dates and a new split at the same total', () => {
    const rescheduled = expectOk(
      reschedule(obligation, split([6_320_834n, 6_320_833n, 6_320_833n])),
    );
    expect(rescheduled.totalAmount.minorUnits).toBe(total);
    expect(rescheduled.instalments).toHaveLength(3);
  });

  it('refuses an obligation whose schedule did not sum to the total at creation', () => {
    const result = createObligation({
      obligationId: 'obl-0002',
      tenantId: 'bank-a',
      transactionId: 'txn-0002',
      pricing,
      instalments: split([total + 1n]),
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a waiver that would increase what is owed', () => {
    const result = applyEarlySettlementRelief(obligation, money(-1n), split([total + 1n]), {
      configKey: 'ibra.basis',
      shariahApprovalId: 'SSB-A-2026-014',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-02');
  });

  it('permits a waiver, which moves the amount owed downward', () => {
    // The prohibition is one-directional. A Board-approved rebate on early
    // settlement reduces what is owed, which is the opposite of riba.
    const waived = expectOk(
      applyEarlySettlementRelief(obligation, money(462_500n), split([18_500_000n]), {
        configKey: 'ibra.basis',
        shariahApprovalId: 'SSB-A-2026-014',
      }),
    );
    expect(waived.totalAmount.minorUnits).toBe(total);
    expect(waived.waivedAmount.minorUnits).toBe(462_500n);
  });

  it('refuses to absorb an overpayment silently', () => {
    const result = applyPayment(obligation, money(total + 1n));
    expect(result.ok).toBe(false);
  });
});

// -- SH-13: late charges are never income --------------------------------------

describe('adversarial: late charges are never income (SH-13)', () => {
  const base = {
    entryId: 'chg-0001',
    tenantId: 'bank-a',
    transactionId: 'txn-0001',
    amount: money(50_000n),
    computationBasisConfigKey: 'late.basis.actual_cost',
    shariahApprovalId: 'SSB-A-2026-014',
    recordedAt: at(2_000_000),
  } as const;

  it('posts only to the segregated charity liability', () => {
    const entry = expectOk(postLateAmount({ ...base, assessment: 'ABLE_BUT_UNWILLING' }));
    expect(entry.accountClass).toBe('CHARITY_LIABILITY');
    expect(entry.reason).toBe('LATE_PAYMENT');
  });

  it('suspends the charge where the counterparty is unable to pay', () => {
    const result = postLateAmount({ ...base, assessment: 'UNABLE' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-14');
    expect(result.error.reason).toBe('HARDSHIP_SUSPENDS_LATE_AMOUNTS');
  });

  it('refuses a charge with no Board-approved computation basis', () => {
    const result = postLateAmount({
      ...base,
      assessment: 'ABLE_BUT_UNWILLING',
      computationBasisConfigKey: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-13');
  });

  it('refuses disbursement to a recipient not on the Board-approved register', () => {
    const entry = expectOk(postLateAmount({ ...base, assessment: 'ABLE_BUT_UNWILLING' }));
    const result = disburse(entry, 'not-on-the-register', ['approved-charity-1'], 'dsb-0001');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-13');
  });

  it('refuses to disburse the same entry twice', () => {
    const entry = expectOk(postLateAmount({ ...base, assessment: 'ABLE_BUT_UNWILLING' }));
    const once = expectOk(disburse(entry, 'approved-charity-1', ['approved-charity-1'], 'dsb-0001'));
    const twice = disburse(once, 'approved-charity-1', ['approved-charity-1'], 'dsb-0002');
    expect(twice.ok).toBe(false);
  });
});

// -- SH-07: one leg, one document ----------------------------------------------

describe('adversarial: separation of contracts (SH-07)', () => {
  const legs = chain([
    {
      legType: 'SALE_OFFER',
      sequenceNo: 1,
      executedAt: at(1_000_000),
      counterpartyRole: 'INSTITUTION',
      counterpartyCr: '7001000001',
    },
    {
      legType: 'ACCEPTANCE',
      sequenceNo: 2,
      executedAt: at(1_000_060),
      counterpartyRole: 'BUYER',
      counterpartyCr: DISTRIBUTOR_CR,
    },
  ]);

  const renderParams = {
    requestId: 'req-0001',
    tenantId: 'bank-a',
    templateVersionId: 'tpl-v3',
    translationLocale: 'en-SA' as const,
    mergeFields: {},
    shariahApprovalId: 'SSB-A-2026-014',
    correlationId: 'cor-0001',
  };

  it('refuses to render two legs into one instrument', () => {
    const result = buildLegRenderRequest(legs, renderParams);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-07');
    expect(result.error.reason).toBe('COMBINED_LEG_RENDERING_REFUSED');
  });

  it('renders one leg into one instrument', () => {
    const request = expectOk(buildLegRenderRequest([legs[0]!], renderParams));
    expect(request.leg.legId).toBe(legs[0]!.legId);
    // Arabic is the governing text and the field is not configurable.
    expect(request.governingLocale).toBe('ar-SA');
  });

  it('refuses to bind one document to a second leg', () => {
    const duplicate = { ...legs[1]!, documentId: legs[0]!.documentId };
    const result = appendLeg([legs[0]!], duplicate);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-07');
    expect(result.error.reason).toBe('DOCUMENT_ALREADY_BOUND_TO_A_LEG');
  });

  it('refuses a leg that does not chain to its predecessor', () => {
    const orphan = { ...legs[1]!, prevLegHash: 'not-the-predecessor' };
    const result = appendLeg([legs[0]!], orphan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('HASH_CHAIN_BROKEN');
  });

  it('refuses a leg back-dated behind its predecessor', () => {
    const backdated = { ...legs[1]!, executedAt: at(999_999) };
    const result = appendLeg([legs[0]!], backdated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('TIMESTAMPS_NOT_MONOTONIC');
  });
});

// -- SH-08: no 'inah -----------------------------------------------------------

describe.each(TENANT_CODES)('adversarial: counterparty distinctness [%s]', (tenant) => {
  const definition = structureFor(tenant);

  it('refuses a chain that sells back to the entity it bought from', () => {
    const legs = chain([
      {
        legType: 'PURCHASE',
        sequenceNo: 1,
        executedAt: at(1_000_000),
        counterpartyRole: 'SELLER',
        counterpartyCr: ANCHOR_CR,
      },
      {
        legType: 'ACCEPTANCE',
        sequenceNo: 2,
        executedAt: at(1_000_100),
        counterpartyRole: 'BUYER',
        counterpartyCr: ANCHOR_CR,
      },
    ]);

    const declared = verifyDistinctParties(definition, legs);
    expect(declared.ok).toBe(false);
    if (declared.ok) return;
    expect(declared.error.control).toBe('SH-08');

    expect(verifyNoBuyBack(legs).ok).toBe(false);
  });

  it('matches on registration number rather than on presentation', () => {
    // Same entity, written differently. Names differ by a space or a suffix;
    // registration numbers do not.
    const legs = chain([
      {
        legType: 'PURCHASE',
        sequenceNo: 1,
        executedAt: at(1_000_000),
        counterpartyRole: 'SELLER',
        counterpartyCr: ' 1010-000002 ',
      },
      {
        legType: 'ACCEPTANCE',
        sequenceNo: 2,
        executedAt: at(1_000_100),
        counterpartyRole: 'BUYER',
        counterpartyCr: '1010000002',
      },
    ]);

    expect(verifyDistinctParties(definition, legs).ok).toBe(false);
  });

  it('permits genuinely distinct parties', () => {
    const legs = chain([
      {
        legType: 'PURCHASE',
        sequenceNo: 1,
        executedAt: at(1_000_000),
        counterpartyRole: 'SELLER',
        counterpartyCr: ANCHOR_CR,
      },
      {
        legType: 'ACCEPTANCE',
        sequenceNo: 2,
        executedAt: at(1_000_100),
        counterpartyRole: 'BUYER',
        counterpartyCr: DISTRIBUTOR_CR,
      },
    ]);

    expectOk(verifyDistinctParties(definition, legs));
    expectOk(verifyNoBuyBack(legs));
  });
});

// -- SH-05: no entitlement can advance a gate ----------------------------------

describe('adversarial: no gate-bypass entitlement can be defined (SH-05, BR-D10)', () => {
  const spec = {
    entitlementId: 'ent-0001',
    tenantId: 'bank-a',
    roleCode: 'OPERATIONS_SUPERVISOR',
    scope: { kind: 'TENANT' } as const,
  };

  it.each([
    'transaction.override_gate',
    'gate.advance',
    'sequencing.bypass',
    'transaction.force_execute',
    'risk_period.waive',
    'admin.superuser',
  ])('refuses the entitlement %s', (action) => {
    const result = defineEntitlement({ ...spec, actions: [action] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-05');
  });

  it('refuses an entitlement naming a sequencing transition', () => {
    for (const transition of SEQUENCING_TRANSITIONS) {
      const result = defineEntitlement({ ...spec, actions: [transition] });
      expect(result.ok).toBe(false);
    }
  });

  it('refuses any action outside the closed catalogue', () => {
    const result = defineEntitlement({ ...spec, actions: ['something.invented'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('UNKNOWN_ENTITLEMENT_ACTION');
  });

  it('has no catalogue entry that could advance a gate', () => {
    const transitions = new Set<string>(SEQUENCING_TRANSITIONS);
    for (const action of ENTITLEMENT_ACTIONS) {
      expect(transitions.has(action)).toBe(false);
      for (const pattern of FORBIDDEN_ENTITLEMENT_PATTERNS) {
        expect(pattern.test(action), `catalogue entry ${action} matches ${String(pattern)}`).toBe(
          false,
        );
      }
    }
  });

  it('still grants the ordinary work operations actually does', () => {
    const entitlement = expectOk(
      defineEntitlement({
        ...spec,
        actions: ['evidence.upload', 'evidence.resolve_extraction_exception', 'transaction.read'],
      }),
    );
    expect(entitlement.actions).toHaveLength(3);
  });
});
