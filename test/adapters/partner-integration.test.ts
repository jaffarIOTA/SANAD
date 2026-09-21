/**
 * Partner integrations.
 *
 * Two things are under test, and the second matters more than the first.
 *
 * The first is that the adapters map correctly. The second is that they hold
 * the line at the boundary: the core banking adapter cannot be pointed at the
 * vendor's lending module, no credential can reach a log, a document render
 * cannot substitute into a Board-approved clause, a signature over a different
 * rendition than the one presented is refused, and an extraction's confidence
 * is floored rather than rounded.
 *
 * Every call runs against recorded fixtures, so the suite is deterministic and
 * needs no network.
 */

import { describe, expect, it } from 'vitest';

import {
  TUUM_DEVIATIONS,
  TuumCoreBankingAdapter,
  type TuumAdapterConfig,
} from '../../adapters/tuum/core-banking-adapter.ts';
import { NutrientDocumentAdapter } from '../../adapters/nutrient/document-adapter.ts';
import { FixtureTransport, type Fixture } from '../../adapters/kernel/fixture-transport.ts';
import { type AdapterConfig, redactForLogging } from '../../adapters/kernel/adapter.ts';
import {
  type CredentialProvider,
  type CredentialRef,
  SecretValue,
} from '../../core/ports/credentials.ts';
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { buildLegRenderRequest } from '../../core/documents/render.ts';
import { DISTRIBUTOR_CR, at, chain } from '../support/fixtures.ts';

/** Records every resolution, so a test can assert the value never escaped. */
class RecordingCredentials implements CredentialProvider {
  readonly resolved: CredentialRef[] = [];

  async get(ref: CredentialRef): Promise<SecretValue> {
    this.resolved.push(ref);
    return new SecretValue('a-provider-credential-value');
  }
}

const now = () => 1_800_000_000;

const baseConfig: AdapterConfig = {
  tenantId: 'bank-a',
  provider: 'CORE_BANKING',
  environment: 'sandbox',
  freshnessWindowSeconds: 300,
  failurePosture: 'QUEUE_AND_RECONCILE',
  credentialTtlSeconds: 600,
  breaker: { failureThreshold: 2, resetAfterSeconds: 30, successThreshold: 1 },
  nowEpochSeconds: now,
};

// =============================================================================
// Core banking — accounts and postings, never the lending module
// =============================================================================

const ACCOUNT_HOST = 'https://account-api.sandbox.example.com';

const tuumConfig: TuumAdapterConfig = {
  ...baseConfig,
  channelCode: 'system',
  hosts: {
    auth: 'https://auth-api.sandbox.example.com',
    person: 'https://person-api.sandbox.example.com',
    account: ACCOUNT_HOST,
    payment: 'https://payment-api.sandbox.example.com',
  },
  accountPurposeCodes: { COLLECTION: 'CURRENCY', SETTLEMENT: 'CURRENCY' },
  institutionAccounts: {
    CHARITY_LIABILITY: 'acct-charity-liability',
    GOODS_INVENTORY: 'acct-goods-inventory',
  },
  transactionTypeCodes: {
    murabahaReceivableRaise: 'MRB_RECV_RAISE',
    murabahaReceivableSettle: 'MRB_RECV_SETTLE',
    goodsInventoryAcquire: 'GOODS_IN',
    goodsInventoryRelease: 'GOODS_OUT',
    charityLiabilityRaise: 'CHARITY_RAISE',
  },
};

function tuum(fixtures: readonly Fixture[], config: Partial<TuumAdapterConfig> = {}) {
  const transport = new FixtureTransport(fixtures);
  const credentials = new RecordingCredentials();
  const adapter = new TuumCoreBankingAdapter(
    { ...tuumConfig, ...config },
    credentials,
    transport,
    async () => ({ restrictedRef: 'resolved-inside-the-boundary' }),
  );
  return { adapter, transport, credentials };
}

const bookingRequest = {
  tenantId: 'bank-a',
  transactionId: 'txn-0001',
  partyRef: { value: 'person-1' },
  collectionAccount: { value: 'acct-collect-1' },
  totalAmount: money(18_962_500n),
  costAmount: money(18_500_000n),
  profitAmount: money(462_500n),
  instalments: [
    {
      instalmentNo: 1,
      dueDateGregorian: '2027-01-04',
      dueDateHijri: '1448-07-25',
      amount: money(18_962_500n),
    },
  ],
  maturityDateGregorian: '2027-01-04',
  maturityDateHijri: '1448-07-25',
  correlationId: 'cor-0001',
} as const;

const postingFixture: Fixture = {
  operation: 'account.postTransaction',
  match: { url: `${ACCOUNT_HOST}/api/v5/accounts/acct-collect-1/transactions` },
  response: { transactionId: 'pst-0001' },
};

describe('core banking adapter — cannot be pointed at the lending module', () => {
  it('refuses a lending host at construction', () => {
    // A deployment misconfigured onto the lending module should fail to start,
    // not fail at the first booking (OI-02, Finding 1).
    expect(() =>
      tuum([], {
        hosts: { ...tuumConfig.hosts, account: 'https://loan-api.sandbox.example.com' },
      }),
    ).toThrow(/lending host/);
  });

  it('exposes no lending operation at all', () => {
    const operations = Object.getOwnPropertyNames(TuumCoreBankingAdapter.prototype);
    for (const name of operations) {
      expect(/loan|contract|offer|disburse|topUp/i.test(name), `method ${name}`).toBe(false);
    }
  });

  it('records why, and what still needs watching', () => {
    const deviation = TUUM_DEVIATIONS.find((d) => d.id === 'TUUM-DEV-004');
    expect(deviation?.verificationRef).toBe('OI-02');
    // The residual risk is the vendor back office, which is outside our boundary.
    expect(deviation?.containment).toContain('reconciliation');
  });
});

describe('core banking adapter — the sale', () => {
  it('books the total as a receivable posting and sends no schedule', async () => {
    const { adapter, transport } = tuum([postingFixture]);
    const ref = expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));
    expect(ref.value).toBe('pst-0001');

    const call = transport.calls[0]!;
    expect(call.url).toBe(`${ACCOUNT_HOST}/api/v5/accounts/acct-collect-1/transactions`);

    const sent = call.request;
    expect(sent['transactionTypeCode']).toBe('MRB_RECV_RAISE');
    expect((sent['money'] as Record<string, unknown>)['amount']).toBe('18962500');

    // The schedule is ours. There is nothing downstream to recompute.
    expect(JSON.stringify(sent)).not.toContain('instalment');
    expect(sent['schedule']).toBeUndefined();

    // Cost and profit travel as detail, for the institution's accounting.
    const details = sent['details'] as Record<string, unknown>;
    expect(details['costMinorUnits']).toBe('18500000');
    expect(details['profitMinorUnits']).toBe('462500');
    expect(
      BigInt(details['costMinorUnits'] as string) + BigInt(details['profitMinorUnits'] as string),
    ).toBe(18_962_500n);
  });

  it('refuses to book a total that is not cost plus profit', async () => {
    const { adapter } = tuum([postingFixture]);
    const result = await adapter.bookObligation(
      { ...bookingRequest, totalAmount: money(18_962_501n) },
      { value: 'idem-1' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-01');
  });

  it('carries the idempotency key the platform actually honours', async () => {
    const { adapter, transport } = tuum([postingFixture]);
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));

    const { headers } = transport.calls[0]!;
    // Verified against the vendor's documentation: reusing this replays the
    // original response rather than creating a second object.
    expect(headers['x-request-id']).toBe('idem-1');
    expect(headers['x-channel-code']).toBe('system');
    expect(headers['x-correlation-id']).toBe('cor-0001');
  });

  it('uses the credential on the wire and redacts it everywhere else', async () => {
    const { adapter, transport } = tuum([postingFixture]);
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));

    const { headers } = transport.calls[0]!;
    expect(headers['x-auth-token']).toBe('a-provider-credential-value');

    const forLog = redactForLogging(headers) as Record<string, unknown>;
    expect(forLog['x-auth-token']).toBe('[redacted]');
    expect(forLog['x-request-id']).toBe('idem-1');
  });
});

describe('core banking adapter — late amounts', () => {
  const charityRequest = {
    tenantId: 'bank-a',
    transactionId: 'txn-0001',
    account: { value: 'acct-anything-the-caller-chose' },
    amount: money(50_000n),
    reasonCode: 'LATE_PAYMENT',
    correlationId: 'cor-0001',
  } as const;

  it('re-derives the segregated account and code rather than trusting the caller', async () => {
    const { adapter, transport } = tuum([
      {
        operation: 'account.postTransaction',
        match: { url: `${ACCOUNT_HOST}/api/v5/accounts/acct-charity-liability/transactions` },
        response: { transactionId: 'pst-0002' },
      },
    ]);

    expectOk(await adapter.postCharityLiability(charityRequest, { value: 'idem-2' }));

    // The caller's account reference is ignored; SH-13 is not delegated.
    const call = transport.calls[0]!;
    expect(call.url).toContain('acct-charity-liability');
    expect(call.url).not.toContain('acct-anything-the-caller-chose');
    expect(call.request['transactionTypeCode']).toBe('CHARITY_RAISE');
  });

  it('refuses when no segregated account is configured', async () => {
    const { adapter } = tuum([], { institutionAccounts: { GOODS_INVENTORY: 'acct-goods' } });
    const result = await adapter.postCharityLiability(charityRequest, { value: 'idem-3' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-13');
  });

  it('has no posting code for revenue', () => {
    expect(Object.keys(tuumConfig.transactionTypeCodes).join(',').toLowerCase()).not.toContain(
      'revenue',
    );
  });
});

describe('core banking adapter — failure posture', () => {
  const failing: Fixture = {
    operation: 'account.postTransaction',
    match: { url: `${ACCOUNT_HOST}/api/v5/accounts/acct-collect-1/transactions` },
    failsWith: 'upstream 503',
    response: {},
  };

  it('queues rather than failing the journey when the core is unavailable', async () => {
    const { adapter } = tuum([failing]);
    await adapter.bookObligation(bookingRequest, { value: 'idem-1' });
    await adapter.bookObligation(bookingRequest, { value: 'idem-2' });
    const third = await adapter.bookObligation(bookingRequest, { value: 'idem-3' });

    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.reason).toBe('CORE_BANKING_CIRCUIT_OPEN');
    expect(third.error.detail).toContain('queued');
  });

  it('never repeats the vendor’s own error text, which can echo a payload', async () => {
    const { adapter } = tuum([
      { ...failing, failsWith: 'validation failed for nationalId 1234567890' },
    ]);
    const result = await adapter.bookObligation(bookingRequest, { value: 'idem-1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain('1234567890');
  });

  it('caches the credential for a bounded period and clears it on disposal', async () => {
    const { adapter, credentials } = tuum([postingFixture]);
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-2' }));
    expect(credentials.resolved).toHaveLength(1);

    adapter.dispose();
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-3' }));
    expect(credentials.resolved).toHaveLength(2);
  });
});

// =============================================================================
// Documents, signature and document intelligence
// =============================================================================

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

const templateFixture: Fixture = {
  operation: 'template.resolve',
  match: { templateVersionId: 'tpl-v3' },
  response: {
    templateId: 'murabaha_offer',
    version: 3,
    lockedRegionIds: ['clause.governing_law', 'clause.disclosure'],
    mergeFieldNames: ['costAmount', 'profitAmount', 'totalAmount', 'maturityDate'],
    shariahApprovalRef: 'SSB-A-2026-014',
  },
};

function nutrient(fixtures: readonly Fixture[]) {
  const transport = new FixtureTransport(fixtures);
  const adapter = new NutrientDocumentAdapter(
    { ...baseConfig, provider: 'DOCUMENT_PLATFORM', failurePosture: 'FAIL_CLOSED' },
    new RecordingCredentials(),
    transport,
  );
  return { adapter, transport };
}

function renderRequest(mergeFields: Record<string, string>) {
  return expectOk(
    buildLegRenderRequest([legs[0]!], {
      requestId: 'req-0001',
      tenantId: 'bank-a',
      templateVersionId: 'tpl-v3',
      translationLocale: 'en-SA',
      mergeFields,
      shariahApprovalId: 'SSB-A-2026-014',
      correlationId: 'cor-0001',
    }),
  );
}

describe('document platform adapter', () => {
  it('renders one leg against an explicit approved template version', async () => {
    const { adapter, transport } = nutrient([
      templateFixture,
      {
        operation: 'document.render',
        match: { legId: 'leg-1' },
        response: {
          documentId: 'doc-0001',
          contentHash: 'sha256-abc',
          artefactUri: 's3://docs/doc-0001',
          pageCount: 4,
          sizeBytes: 90_000,
        },
      },
    ]);

    const rendered = expectOk(
      await adapter.render(renderRequest({ costAmount: '185000.00', profitAmount: '4625.00' })),
    );
    expect(rendered.documentId).toBe('doc-0001');

    const sent = transport.calls[1]!.request;
    expect(sent['governingLocale']).toBe('ar-SA');
    expect(sent['templateVersionId']).toBe('tpl-v3');
  });

  it('refuses to substitute into anything the approved template did not declare', async () => {
    const { adapter } = nutrient([templateFixture]);
    const result = await adapter.render(
      renderRequest({ 'clause.governing_law': 'somewhere else entirely' }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-07');
    expect(result.error.reason).toBe('UNDECLARED_MERGE_FIELD');
  });

  it('refuses a template version that carries no approval reference', async () => {
    const { adapter } = nutrient([
      {
        operation: 'template.resolve',
        match: { templateVersionId: 'tpl-v3' },
        response: { templateId: 'murabaha_offer', version: 3, mergeFieldNames: [] },
      },
    ]);

    const result = await adapter.render(renderRequest({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-17');
  });

  it('refuses "latest" in place of an explicit version', async () => {
    const { adapter } = nutrient([]);
    const result = await adapter.resolveTemplateVersion('bank-a', 'murabaha_offer', 0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('TEMPLATE_VERSION_NOT_EXPLICIT');
  });

  it('refuses a signature over a rendition other than the one presented', async () => {
    const { adapter } = nutrient([
      {
        operation: 'signature.seal',
        match: { documentId: 'doc-0001' },
        response: {
          signatureId: 'sig-0001',
          contentHash: 'sha256-something-else',
          timestamp: {
            verified: true,
            genTimeEpochSeconds: 1_800_000_000,
            tokenDigest: 'tsa-digest',
            authorityId: 'tsa-1',
          },
        },
      },
    ]);

    const result = await adapter.sealLeg({
      tenantId: 'bank-a',
      documentId: 'doc-0001',
      contentHash: 'sha256-abc',
      signatoryAssertion: { value: 'asr-0001' },
      correlationId: 'cor-0001',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('SIGNED_RENDITION_DIFFERS');
  });

  it('refuses to execute a leg with no verifiable timestamp', async () => {
    const { adapter } = nutrient([
      {
        operation: 'signature.seal',
        match: { documentId: 'doc-0001' },
        response: { signatureId: 'sig-0001', contentHash: 'sha256-abc' },
      },
    ]);

    const result = await adapter.sealLeg({
      tenantId: 'bank-a',
      documentId: 'doc-0001',
      contentHash: 'sha256-abc',
      signatoryAssertion: { value: 'asr-0001' },
      correlationId: 'cor-0001',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-06');
    expect(result.error.reason).toBe('NO_TRUSTED_TIMESTAMP');
  });

  it('seals a leg and returns the attested instant', async () => {
    const { adapter } = nutrient([
      {
        operation: 'signature.seal',
        match: { documentId: 'doc-0001' },
        response: {
          signatureId: 'sig-0001',
          contentHash: 'sha256-abc',
          timestamp: {
            verified: true,
            genTimeEpochSeconds: 1_800_000_000,
            tokenDigest: 'tsa-digest',
            authorityId: 'tsa-1',
          },
        },
      },
    ]);

    const signed = expectOk(
      await adapter.sealLeg({
        tenantId: 'bank-a',
        documentId: 'doc-0001',
        contentHash: 'sha256-abc',
        signatoryAssertion: { value: 'asr-0001' },
        correlationId: 'cor-0001',
      }),
    );

    expect(signed.profile).toBe('INSTITUTIONAL_SEAL');
    expect(signed.timestamp.genTimeEpochSeconds).toBe(1_800_000_000n);
  });

  it('floors extraction confidence rather than rounding it', async () => {
    const { adapter } = nutrient([
      {
        operation: 'intelligence.extract',
        match: { artefactUri: 's3://uploads/delivery-note.pdf' },
        response: {
          documentClass: 'DELIVERY_NOTE',
          fields: [
            { name: 'deliveredOn', value: '2026-09-14', confidence: 0.94999 },
            { name: 'quantity', value: '400', confidence: 0.9812 },
          ],
        },
      },
    ]);

    const outcome = expectOk(
      await adapter.extract({
        tenantId: 'bank-a',
        artefactUri: 's3://uploads/delivery-note.pdf',
        expectedDocumentClass: 'DELIVERY_NOTE',
        locales: ['ar-SA'],
        correlationId: 'cor-0001',
      }),
    );

    // 0.94999 is not 95%, and treating it as such is how a borderline
    // extraction quietly discharges a gate it should not.
    expect(outcome.fields[0]?.confidencePerTenThousand).toBe(9499);
    expect(outcome.lowestConfidencePerTenThousand).toBe(9499);
    for (const field of outcome.fields) {
      expect(Number.isInteger(field.confidencePerTenThousand)).toBe(true);
    }
  });

  it('refuses to disclose outside the institution with an empty redaction rule set', async () => {
    const { adapter } = nutrient([]);
    const result = await adapter.redact({
      tenantId: 'bank-a',
      documentId: 'doc-0001',
      rules: [],
      recipientClass: 'GUARANTOR',
      correlationId: 'cor-0001',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('NO_REDACTION_RULES');
  });
});

// =============================================================================
// Credentials
// =============================================================================

describe('credentials never reach a log, a trace or an error', () => {
  const secret = new SecretValue('the-actual-provider-key');

  it('redacts itself in a template literal', () => {
    expect(`${secret}`).toBe('[redacted]');
  });

  it('redacts itself when serialised', () => {
    expect(JSON.stringify({ apiToken: secret })).toBe('{"apiToken":"[redacted]"}');
  });

  it('yields its value only through an explicit, greppable call', () => {
    expect(secret.expose()).toBe('the-actual-provider-key');
  });

  it('redacts credential-shaped and identity-shaped keys on the way to a log', () => {
    const redacted = redactForLogging({
      transactionId: 'txn-0001',
      authorization: 'Bearer abc',
      party: { nationalId: '1234567890', legalNameEn: 'A Company' },
      amountMinorUnits: 18_962_500n,
    }) as Record<string, unknown>;

    expect(redacted['authorization']).toBe('[redacted]');
    expect((redacted['party'] as Record<string, unknown>)['nationalId']).toBe('[redacted]');
    // Business data is not personal data, and stays legible for support.
    expect(redacted['transactionId']).toBe('txn-0001');
    expect((redacted['party'] as Record<string, unknown>)['legalNameEn']).toBe('A Company');
    expect(redacted['amountMinorUnits']).toBe('18962500');
  });
});
