/**
 * Partner integrations.
 *
 * Two things are under test here, and the second matters more than the first.
 *
 * The first is that the adapters map correctly. The second is that they hold
 * the line at the boundary: nothing rate-shaped goes down to the core banking
 * platform from a domain object that has no such concept; no credential can
 * reach a log; a document render cannot substitute into a Board-approved
 * clause; a signature over a different rendition than the one presented is
 * refused; and an extraction's confidence is floored rather than rounded.
 *
 * Every call runs against recorded fixtures, so the suite is deterministic and
 * needs no network. The fixtures encode what we currently believe the vendor
 * contracts to be — both are unverified, tracked as OI-02 and OI-05 — and will
 * be re-recorded from a sandbox when one is available.
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

const CLOCK = { seconds: 1_800_000_000 };
const now = () => CLOCK.seconds;

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
// Core banking
// =============================================================================

const tuumConfig: TuumAdapterConfig = {
  ...baseConfig,
  vendorPricingCompatibilityFields: {},
  accountPurposeCodes: {
    SETTLEMENT: 'CA-SETTLE',
    COLLECTION: 'CA-COLLECT',
    CHARITY_LIABILITY: 'CA-CHARITY',
    GOODS_INVENTORY: 'CA-INVENTORY',
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
  partyRef: { value: 'party-1' },
  collectionAccount: { value: 'acct-1' },
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

describe('core banking adapter', () => {
  const bookFixture: Fixture = {
    operation: 'obligation.book',
    match: { partyId: 'party-1' },
    response: { bookingId: 'bkg-0001' },
  };

  it('sends a fixed total and a schedule, and nothing that could be recomputed', async () => {
    const { adapter, transport } = tuum([bookFixture]);
    const ref = expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));
    expect(ref.value).toBe('bkg-0001');

    const sent = transport.calls[0]!.request;
    expect(sent['totalAmountMinorUnits']).toBe('18962500');
    expect(sent['costAmountMinorUnits']).toBe('18500000');
    expect(sent['profitAmountMinorUnits']).toBe('462500');

    // Cost plus profit is the total, on the wire as well as in the domain.
    expect(BigInt(sent['costAmountMinorUnits'] as string) + BigInt(sent['profitAmountMinorUnits'] as string)).toBe(
      BigInt(sent['totalAmountMinorUnits'] as string),
    );

    // Amounts travel as integer strings. No floating point leaves the boundary.
    for (const key of ['totalAmountMinorUnits', 'costAmountMinorUnits', 'profitAmountMinorUnits']) {
      expect(typeof sent[key]).toBe('string');
      expect(String(sent[key])).toMatch(/^\d+$/);
    }
  });

  it('carries a vendor pricing compatibility field only when configuration supplies one', async () => {
    // TUUM-DEV-001. The field name is configuration, not code, because the
    // vendor's requirement here is unverified and the concept must not be named
    // in the repository outside the adapter's README.
    const { adapter, transport } = tuum([bookFixture], {
      vendorPricingCompatibilityFields: { legacyPricingMode: 'FIXED_PRICE_NO_ACCRUAL' },
    });
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));

    expect(transport.calls[0]!.request['legacyPricingMode']).toBe('FIXED_PRICE_NO_ACCRUAL');
  });

  it('declares that deviation, how it is contained, and what tracks it', () => {
    const deviation = TUUM_DEVIATIONS.find((d) => d.id === 'TUUM-DEV-001');
    expect(deviation?.verificationRef).toBe('OI-02');
    expect(deviation?.containment).toContain('configuration');
  });

  it('sends the idempotency key on every write, so a retry is safe', async () => {
    const { adapter, transport } = tuum([bookFixture]);
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));

    const { headers } = transport.calls[0]!;
    expect(headers['Idempotency-Key']).toBe('idem-1');
    expect(headers['X-Correlation-Id']).toBe('cor-0001');
  });

  it('uses the credential on the wire and redacts it everywhere else', async () => {
    const { adapter, transport } = tuum([bookFixture]);
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));

    const { headers } = transport.calls[0]!;
    // The one place the plaintext legitimately appears.
    expect(headers['Authorization']).toContain('a-provider-credential-value');
    // And the one thing that must happen to it before it goes anywhere else.
    const forLog = redactForLogging(headers) as Record<string, unknown>;
    expect(forLog['Authorization']).toBe('[redacted]');
    expect(forLog['Idempotency-Key']).toBe('idem-1');
  });

  it('re-derives the charity account rather than trusting the caller', async () => {
    const { adapter, transport } = tuum([
      {
        operation: 'posting.charityLiability',
        match: { accountId: 'acct-anything' },
        response: { postingId: 'pst-0001' },
      },
    ]);

    expectOk(
      await adapter.postCharityLiability(
        {
          tenantId: 'bank-a',
          transactionId: 'txn-0001',
          account: { value: 'acct-anything' },
          amount: money(50_000n),
          reasonCode: 'LATE_PAYMENT',
          correlationId: 'cor-0001',
        },
        { value: 'idem-2' },
      ),
    );

    // Whatever account reference came in, the posting is typed to the
    // segregated charity account the tenant configured (SH-13).
    expect(transport.calls[0]!.request['accountTypeCode']).toBe('CA-CHARITY');
  });

  it('refuses to post a late amount when no segregated account is configured', async () => {
    const { adapter } = tuum([], {
      accountPurposeCodes: {
        SETTLEMENT: 'CA-SETTLE',
        COLLECTION: 'CA-COLLECT',
        GOODS_INVENTORY: 'CA-INVENTORY',
      } as TuumAdapterConfig['accountPurposeCodes'],
    });

    const result = await adapter.postCharityLiability(
      {
        tenantId: 'bank-a',
        transactionId: 'txn-0001',
        account: { value: 'acct-1' },
        amount: money(50_000n),
        reasonCode: 'LATE_PAYMENT',
        correlationId: 'cor-0001',
      },
      { value: 'idem-3' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe('SH-13');
  });

  it('queues rather than failing the journey when the core is unavailable', async () => {
    const { adapter } = tuum([
      { operation: 'obligation.book', match: { partyId: 'party-1' }, failsWith: 'upstream 503', response: {} },
    ]);

    const first = await adapter.bookObligation(bookingRequest, { value: 'idem-1' });
    const second = await adapter.bookObligation(bookingRequest, { value: 'idem-2' });
    const third = await adapter.bookObligation(bookingRequest, { value: 'idem-3' });

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    // Two failures open the circuit; the third never reaches the vendor.
    expect(third.error.reason).toBe('CORE_BANKING_CIRCUIT_OPEN');
    expect(third.error.detail).toContain('queued');
  });

  it('never repeats the vendor’s own error text, which can echo a payload', async () => {
    const { adapter } = tuum([
      {
        operation: 'obligation.book',
        match: { partyId: 'party-1' },
        failsWith: 'validation failed for nationalId 1234567890',
        response: {},
      },
    ]);

    const result = await adapter.bookObligation(bookingRequest, { value: 'idem-1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).not.toContain('1234567890');
  });

  it('caches the credential for a bounded period rather than refetching per call', async () => {
    const { adapter, credentials } = tuum([bookFixture, { ...bookFixture, match: { partyId: 'party-1' } }]);
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-1' }));
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-2' }));
    expect(credentials.resolved).toHaveLength(1);

    adapter.dispose();
    expectOk(await adapter.bookObligation(bookingRequest, { value: 'idem-3' }));
    // Disposal clears it: a credential does not outlive the adapter that needed it.
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
    // Arabic governs, and the request says so explicitly rather than by default.
    expect(sent['governingLocale']).toBe('ar-SA');
    expect(sent['templateVersionId']).toBe('tpl-v3');
  });

  it('refuses to substitute into anything the approved template did not declare', async () => {
    // NUTR-DEV-002. A Board-approved clause is not a merge field, and the
    // adapter enforces that before the call rather than trusting the engine.
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
    // A compliance dependency never degrades. No trusted time, no leg.
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
    // NUTR-DEV-001. 0.94999 is not 95%, and treating it as such is how a
    // borderline extraction quietly discharges a gate it should not.
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

    expect(outcome.fields[0]?.confidencePerTenThousand).toBe(9499);
    expect(outcome.lowestConfidencePerTenThousand).toBe(9499);
    // Integers all the way, so a gate's floor is never a float comparison.
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
    // An empty rule set is not a decision to disclose everything.
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
    // bigint survives serialisation as a string rather than throwing.
    expect(redacted['amountMinorUnits']).toBe('18962500');
  });
});
