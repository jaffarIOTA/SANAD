/**
 * The document platform adapter, checked without the vendor.
 *
 * A fake transport records every call and answers from a script, so what is
 * under test is the adapter's own promises: an explicit template version or
 * nothing, no substitution into undeclared fields, confidence floored and
 * never rounded up, a signature that fails closed without a trusted timestamp
 * or when the signed hash differs, an empty redaction set that is a refusal,
 * the saved credential key name, and no secret in any outcome.
 *
 * None of this proves the vendor behaves. That is the verification runbook's
 * job (adapters/nutrient/verification/README.md).
 */
import { describe, expect, it } from 'vitest';

import { type CredentialProvider, type CredentialRef, SecretValue } from '../../core/ports/credentials.ts';
import { type AdapterConfig } from '../../adapters/kernel/adapter.ts';
import { NutrientDocumentAdapter, type NutrientOperation, type NutrientTransport } from '../../adapters/nutrient/document-adapter.ts';

const TOKEN = 'fixture-engine-token-for-this-test-only';

class Credentials implements CredentialProvider {
  readonly reads: CredentialRef[] = [];
  get(ref: CredentialRef): Promise<SecretValue> { this.reads.push(ref); return Promise.resolve(new SecretValue(TOKEN)); }
}

interface Call { readonly operation: NutrientOperation; readonly payload: Readonly<Record<string, unknown>>; readonly headers: Readonly<Record<string, string>> }

class ScriptedTransport implements NutrientTransport {
  readonly calls: Call[] = [];
  constructor(private readonly script: Partial<Record<NutrientOperation, Readonly<Record<string, unknown>> | Error>>) {}
  call(operation: NutrientOperation, payload: Readonly<Record<string, unknown>>, headers: Readonly<Record<string, string>>): Promise<Readonly<Record<string, unknown>>> {
    this.calls.push({ operation, payload, headers });
    const answer = this.script[operation];
    if (answer === undefined) return Promise.reject(new Error(`no script for ${operation}`));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  }
}

const CONFIG: AdapterConfig = {
  tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', freshnessWindowSeconds: 0, failurePosture: 'FAIL_CLOSED', credentialTtlSeconds: 600,
  breaker: { failureThreshold: 2, resetAfterSeconds: 30, successThreshold: 1 }, nowEpochSeconds: () => 1_800_000_000,
};

const TEMPLATE = { templateVersionId: 'tv-7', templateId: 'promissory-note', version: 3, lockedRegionIds: ['clause-1', 'clause-2'], mergeFieldNames: ['payee', 'amountFigures', 'amountWords'], shariahApprovalRef: 'SSB-A-2026-014' };
const TIMESTAMP = { verified: true, genTimeEpochSeconds: 1_800_000_100, tokenDigest: 'tsa-digest', authorityId: 'tsa-test' };

const build = (script: ConstructorParameters<typeof ScriptedTransport>[0]) => {
  const credentials = new Credentials(); const transport = new ScriptedTransport(script);
  return { adapter: new NutrientDocumentAdapter(CONFIG, credentials, transport), credentials, transport };
};

const renderRequest = (mergeFields: Record<string, string>) => ({
  requestId: 'req-1', tenantId: 'bank-a', subject: { kind: 'PROMISSORY_NOTE', reference: 'pn-1', detail: {} }, templateVersionId: 'tv-7',
  governingLocale: 'ar-SA' as const, translationLocale: 'en-SA' as const, mergeFields, correlationId: 'cor-1',
});

describe('credentials and headers', () => {
  it('reads the key the saving guide names and presents it as a token scheme', async () => {
    const { adapter, credentials, transport } = build({ 'template.resolve': TEMPLATE });
    await adapter.resolveTemplateVersion('bank-a', 'promissory-note', 3);
    expect(credentials.reads.map((r) => r.keyName)).toEqual(['document_engine_api_token']);
    expect(credentials.reads[0]?.provider).toBe('DOCUMENT_PLATFORM');
    expect(transport.calls[0]?.headers['Authorization']).toBe(`Token token=${TOKEN}`);
  });
  it('carries the token in no outcome, success or refusal', async () => {
    const { adapter } = build({ 'template.resolve': new Error('boom') });
    const refused = await adapter.resolveTemplateVersion('bank-a', 'promissory-note', 3);
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
    const ok = await build({ 'template.resolve': TEMPLATE }).adapter.resolveTemplateVersion('bank-a', 'promissory-note', 3);
    expect(JSON.stringify(ok)).not.toContain(TOKEN);
  });
});

describe('templates and rendering', () => {
  it('refuses "latest": a version must be an explicit positive whole number', async () => {
    const { adapter, transport } = build({ 'template.resolve': TEMPLATE });
    for (const v of [0, -1, 1.5, Number.NaN]) {
      const r = await adapter.resolveTemplateVersion('bank-a', 'promissory-note', v);
      expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('TEMPLATE_VERSION_NOT_EXPLICIT');
    }
    expect(transport.calls).toHaveLength(0);
  });
  it('refuses a template version with no approval reference', async () => {
    const { adapter } = build({ 'template.resolve': { ...TEMPLATE, shariahApprovalRef: undefined } });
    const r = await adapter.resolveTemplateVersion('bank-a', 'promissory-note', 3);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('TEMPLATE_METADATA_INCOMPLETE');
  });
  it('refuses a render that substitutes into an undeclared field, before any render call (NUTR-DEV-002)', async () => {
    const { adapter, transport } = build({ 'template.resolve': TEMPLATE, 'document.render': { documentId: 'd', contentHash: 'h', artefactUri: 'u' } });
    const r = await adapter.render(renderRequest({ payee: 'x', 'clause-1': 'rewritten' }));
    expect(r.ok).toBe(false); if (!r.ok) { expect(r.error.reason).toBe('UNDECLARED_MERGE_FIELD'); expect(r.error.control).toBe('SH-07'); }
    expect(transport.calls.map((c) => c.operation)).toEqual(['template.resolve']);
  });
  it('renders a declared subset and binds the result to the version it asked for', async () => {
    const { adapter, transport } = build({ 'template.resolve': TEMPLATE, 'document.render': { documentId: 'doc-1', contentHash: 'sha256:abc', artefactUri: 's3://x', pageCount: 2, sizeBytes: 4096 } });
    const r = await adapter.render(renderRequest({ payee: 'x', amountFigures: '1000.00' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ documentId: 'doc-1', contentHash: 'sha256:abc', artefactUri: 's3://x', templateVersionId: 'tv-7', pageCount: 2, sizeBytes: 4096 });
    expect(transport.calls[1]?.payload['governingLocale']).toBe('ar-SA');
  });
  it('reports drift when any locked region changed', async () => {
    const { adapter } = build({ 'document.compare': { alteredLockedRegionIds: ['clause-2'], summary: 'clause 2 differs' } });
    const r = await adapter.compareToTemplate('doc-1', 'tv-7');
    expect(r.ok && r.value.hasDrift).toBe(true);
  });
});

describe('signing fails closed', () => {
  const params = { tenantId: 'bank-a', documentId: 'doc-1', contentHash: 'sha256:abc', signatoryAssertion: { value: 'asr-1' }, correlationId: 'cor-9' };
  it('signs the presented rendition and returns the trusted timestamp', async () => {
    const { adapter, transport } = build({ 'signature.padesLtv': { signatureId: 'sig-1', contentHash: 'sha256:abc', timestamp: TIMESTAMP } });
    const r = await adapter.signMasterAgreement(params);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.profile).toBe('PADES_LTV'); expect(r.value.timestamp.genTimeEpochSeconds).toBe(1_800_000_100n); }
    expect(transport.calls[0]?.payload['requestTimestamp']).toBe(true);
    expect(transport.calls[0]?.payload['identityAssertionId']).toBe('asr-1');
  });
  it('refuses when the signed hash is not the presented hash', async () => {
    const { adapter } = build({ 'signature.seal': { signatureId: 'sig-1', contentHash: 'sha256:OTHER', timestamp: TIMESTAMP } });
    const r = await adapter.sealLeg(params);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('SIGNED_RENDITION_DIFFERS');
  });
  it('refuses a signature without a verified timestamp (SH-06)', async () => {
    for (const timestamp of [undefined, { ...TIMESTAMP, verified: false }, { ...TIMESTAMP, tokenDigest: undefined }]) {
      const { adapter } = build({ 'signature.seal': { signatureId: 'sig-1', contentHash: 'sha256:abc', timestamp } });
      const r = await adapter.sealLeg(params);
      expect(r.ok).toBe(false); if (!r.ok) { expect(r.error.reason).toBe('NO_TRUSTED_TIMESTAMP'); expect(r.error.control).toBe('SH-06'); }
    }
  });
  it('reads validation flags as false unless the engine said true', async () => {
    const { adapter } = build({ 'signature.validate': { signatureValid: true, certificateChainValid: 'yes', timestampValid: 1, validatedAtEpochSeconds: 1_800_000_200 } });
    const r = await adapter.validate('doc-1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ signatureValid: true, certificateChainValid: false, timestampValid: false, longTermValidationPresent: false, validatedAgainstEpochSeconds: 1_800_000_200n });
  });
});

describe('document intelligence', () => {
  const params = { tenantId: 'bank-a', artefactUri: 's3://sample', expectedDocumentClass: 'DELIVERY_NOTE', locales: ['ar-SA' as const], correlationId: 'cor-2' };
  it('floors confidence to an integer per ten thousand and never rounds up (NUTR-DEV-001)', async () => {
    const { adapter } = build({ 'intelligence.extract': { documentClass: 'DELIVERY_NOTE', fields: [
      { name: 'consignee', value: 'A', confidence: 0.87659 }, { name: 'quantity', value: '120', confidence: 0.99999 },
      { name: 'date', value: '2026-09-14', confidence: 1 }, { name: 'weight', value: '', confidence: -0.2 }, { name: 'ignored', value: 7, confidence: 0.5 },
    ] } });
    const r = await adapter.extract(params);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fields.map((f) => [f.name, f.confidencePerTenThousand])).toEqual([['consignee', 8765], ['quantity', 9999], ['date', 10000], ['weight', 0]]);
    expect(r.value.lowestConfidencePerTenThousand).toBe(0);
    expect(Number.isInteger(r.value.lowestConfidencePerTenThousand)).toBe(true);
  });
  it('an extraction with no fields has no confidence to discharge anything', async () => {
    const { adapter } = build({ 'intelligence.extract': { fields: [] } });
    const r = await adapter.extract(params);
    expect(r.ok && r.value.lowestConfidencePerTenThousand).toBe(0);
    expect(r.ok && r.value.documentClass).toBe('DELIVERY_NOTE');
  });
  it('refuses an unreadable extraction rather than returning an empty success', async () => {
    const { adapter } = build({ 'intelligence.extract': { fields: 'none' } });
    const r = await adapter.extract(params);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('EXTRACTION_MALFORMED');
  });
  it('treats an empty redaction rule set for a recipient as a refusal, not a disclosure', async () => {
    const { adapter, transport } = build({ 'intelligence.redact': { redactedDocumentId: 'r', artefactUri: 'u' } });
    const r = await adapter.redact({ tenantId: 'bank-a', documentId: 'doc-1', rules: [{ fieldName: 'nationalId', recipientClass: 'REGULATOR' }], recipientClass: 'EXTERNAL_COUNSEL', correlationId: 'cor-3' });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('NO_REDACTION_RULES');
    expect(transport.calls).toHaveLength(0);
  });
  it('sends only the rules for the recipient, in a stable order', async () => {
    const { adapter, transport } = build({ 'intelligence.redact': { redactedDocumentId: 'r', artefactUri: 'u' } });
    await adapter.redact({ tenantId: 'bank-a', documentId: 'doc-1', rules: [{ fieldName: 'salary', recipientClass: 'EXTERNAL_COUNSEL' }, { fieldName: 'nationalId', recipientClass: 'EXTERNAL_COUNSEL' }, { fieldName: 'x', recipientClass: 'REGULATOR' }], recipientClass: 'EXTERNAL_COUNSEL', correlationId: 'cor-3' });
    expect(transport.calls[0]?.payload['fieldNames']).toEqual(['nationalId', 'salary']);
  });
});

describe('unavailability is a typed outcome', () => {
  it('a failed call is a refusal naming the operation, and the breaker opens after the threshold', async () => {
    const { adapter } = build({ 'signature.validate': new Error('ECONNRESET') });
    const first = await adapter.validate('doc-1'); const second = await adapter.validate('doc-1'); const third = await adapter.validate('doc-1');
    expect(first.ok).toBe(false); if (!first.ok) expect(first.error.reason).toBe('DOCUMENT_PLATFORM_CALL_FAILED');
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(false); if (!third.ok) expect(third.error.reason).toBe('DOCUMENT_PLATFORM_CIRCUIT_OPEN');
  });
});
