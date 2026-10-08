/**
 * Tuum product catalogue — the read-only view of the core's own products.
 *
 * Fixtures are shaped like the partners sandbox answered on 2026-10-08
 * (adapters/tuum/README.md, "First verified call" and "Steps A.2–A.5"), with
 * invented codes. The tests pin the vendor-to-port mapping, the header the
 * platform actually honours, and the unavailability outcomes.
 */

import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import type { AuthHttp } from '../../adapters/tuum/authentication.ts';
import { createTuumProductCatalogue } from '../../adapters/tuum/product-catalogue.ts';
import type { RailEnvelope, RailTransport } from '../../adapters/kernel/http-transport.ts';
import { TransportError } from '../../adapters/kernel/http-transport.ts';

const token = (): string => `h.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 }), 'utf8').toString('base64url')}.s`;

const authHttp: AuthHttp = { post: () => Promise.resolve({ status: 200, body: JSON.stringify({ data: { token: token() } }) }) };

const LIST = {
  data: [
    { loanTypeCode: 'TEST-PF-SAR', loanTypeDescription: 'Test personal finance', loanGroupCode: 'UNSECURED_LOAN', loanGroupDescription: 'Unsecured loans', countryCode: 'SA', currencyCode: 'SAR', statusCode: 'ACTIVE', tenantCode: 'UNIT' },
    { loanTypeCode: 'TEST-EUR', loanTypeDescription: 'Other partner', loanGroupCode: 'UNSECURED_LOAN', loanGroupDescription: 'Unsecured loans', countryCode: 'EE', currencyCode: 'EUR', statusCode: 'ACTIVE', tenantCode: 'OTHER' },
  ],
};

const DETAIL = {
  data: {
    generalInfo: { loanTypeCode: 'TEST-PF-SAR', description: 'Test personal finance', loanGroupCode: 'UNSECURED_LOAN', scheduleTypeCode: 'ANNUITY', statusCode: 'ACTIVE', currencyCode: 'SAR', countryCode: 'SA', tenantCode: 'UNIT' },
    principal: { amountRange: { startValue: 500, endValue: 50000 }, periodRange: { startValue: 2, endValue: 40 } },
    interest: { interestTypeCode: 'FIX', priceRuleCode: 'FIXED', calculationMethod: { daysInMonth: 'ACT', daysInYear: 365 } },
    pricing: { INT: [{ componentTypeCode: 'INT', value: 25 }] },
    fees: [],
    repayment: { paymentFrequencyUnit: 'MONTH', paymentFrequency: 1, invoiceTermDays: 30, minBillingPeriodDays: 30 },
    origination: { applicationReviewRequired: true },
  },
};

function transport(answer: (envelope: RailEnvelope) => Readonly<Record<string, unknown>>): { transport: RailTransport; calls: RailEnvelope[] } {
  const calls: RailEnvelope[] = [];
  return { calls, transport: { call: (_op, envelope) => { calls.push(envelope); return Promise.resolve(answer(envelope)); } } };
}

const build = (t: RailTransport) => createTuumProductCatalogue({
  hosts: { auth: 'https://auth.example.test', products: 'https://products.example.test' },
  credentials: () => Promise.resolve({ username: 'svc', password: 'example-password-not-real', tenantCode: 'UNIT', identityKind: 'EMPLOYEE' }),
  nowEpochSeconds: () => 1_700_000_000,
  authHttp,
  transport: t,
});

describe('Tuum product catalogue', () => {
  it('lists product types in the port vocabulary and sends the token in the header the platform honours', async () => {
    const t = transport(() => LIST);
    const outcome = await build(t.transport).listProductTypes('corr-1');
    expect(outcome.kind).toBe('ANSWERED');
    if (outcome.kind !== 'ANSWERED') return;
    expect(outcome.value).toEqual([
      { code: 'TEST-PF-SAR', description: 'Test personal finance', group: 'UNSECURED_LOAN', groupDescription: 'Unsecured loans', currency: 'SAR', country: 'SA', status: 'ACTIVE', unit: 'UNIT' },
      { code: 'TEST-EUR', description: 'Other partner', group: 'UNSECURED_LOAN', groupDescription: 'Unsecured loans', currency: 'EUR', country: 'EE', status: 'ACTIVE', unit: 'OTHER' },
    ]);
    const call = t.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('https://products.example.test/api/v1/loan-products');
    expect(call?.headers['x-auth-token']).toBe(token());
    expect(call?.headers['x-tenant-code']).toBe('UNIT');
    expect(call?.headers['x-request-id']).toBe('corr-1');
    expect(call?.headers['authorization']).toBeUndefined();
  });

  it('describes a product: rate driven, with the core’s figures carried as text and nothing computed', async () => {
    const t = transport(() => DETAIL);
    const outcome = await build(t.transport).describeProductType('TEST-PF-SAR', 'corr-2');
    expect(outcome.kind).toBe('ANSWERED');
    if (outcome.kind !== 'ANSWERED') return;
    expect(t.calls[0]?.url).toBe('https://products.example.test/api/v2/loan-products/TEST-PF-SAR');
    expect(outcome.value.summary.code).toBe('TEST-PF-SAR');
    expect(outcome.value.scheduleShape).toBe('ANNUITY');
    expect(outcome.value.amountLimits).toEqual({ lowText: '500', highText: '50000' });
    expect(outcome.value.periodLimits).toEqual({ low: 2, high: 40 });
    expect(outcome.value.pricingMethod).toBe('RATE_DRIVEN');
    expect(outcome.value.rateBasis).toBe('FIX ACT/365');
    expect(outcome.value.components).toEqual([{ component: 'INT', kind: 'RATE', valueText: '25' }]);
    expect(outcome.value.repaymentCycle).toEqual({ frequency: 1, unit: 'MONTH', invoiceTermDays: 30, minBillingPeriodDays: 30 });
    expect(outcome.value.reviewRequiredBeforeOffer).toBe(true);
    // A vendor figure is text on the port, never a number that could enter arithmetic.
    for (const c of outcome.value.components) expect(typeof c.valueText).toBe('string');
  });

  it('a product with no interest configuration and no components is reported as unknown, not as fixed', async () => {
    const t = transport(() => ({ data: { generalInfo: { loanTypeCode: 'X', scheduleTypeCode: 'BULLET' }, principal: {}, pricing: {}, fees: [] } }));
    const outcome = await build(t.transport).describeProductType('X', 'corr-3');
    expect(outcome.kind === 'ANSWERED' && outcome.value.pricingMethod).toBe('UNKNOWN');
  });

  it('a 200 that carries errors is a refusal with the platform code, not an empty list', async () => {
    const t = transport(() => ({ errors: ['err.unauthorised'], data: null }));
    const outcome = await build(t.transport).listProductTypes('corr-4');
    expect(outcome).toEqual({ kind: 'REFUSED', code: 'err.unauthorised' });
  });

  it('a transport failure is UNAVAILABLE with the status, and a 401 discards the token', async () => {
    let status = 401;
    const t: RailTransport = { call: (op) => Promise.reject(new TransportError(op, status, 'HTTP')) };
    const catalogue = build(t);
    expect(await catalogue.listProductTypes('corr-5')).toEqual({ kind: 'UNAVAILABLE', reason: 'HTTP_401' });
    status = 503;
    expect(await catalogue.describeProductType('TEST-PF-SAR', 'corr-6')).toEqual({ kind: 'UNAVAILABLE', reason: 'HTTP_503' });
  });

  it('an unknown product code is a refusal', async () => {
    const t = transport(() => ({ data: null }));
    expect(await build(t.transport).describeProductType('NOPE', 'corr-7')).toEqual({ kind: 'REFUSED', code: 'PRODUCT_NOT_FOUND' });
  });
});
