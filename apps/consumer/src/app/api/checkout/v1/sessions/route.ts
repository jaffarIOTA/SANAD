import { randomUUID } from 'node:crypto';

import { create } from '@sanad/core/checkout/session.ts';
import { canTransact } from '@sanad/core/merchants/merchant.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { fromRejection, problem } from '@sanad/origination/problem.ts';

import { consumerBaseUrl, contract, correlation, json, merchantOr401, refuse, toWire } from '../shared.ts';
import { merchantById, refreshMerchants } from '@/server/merchants.ts';
import { findSession, rememberIdempotency, saveSession, sessionIdFor } from '@/server/checkout-store.ts';
import { flushConsumerStore, syncConsumerStore } from '@/server/durable.ts';
import { developmentAttestation } from '@/server/store.ts';

const validate = contract.validatorFor('CreateCheckoutSession');
const SESSION_TTL_SECONDS = 1_800n;

interface Body { readonly merchantOrderRef: string; readonly basket: { readonly minorUnits: string; readonly currency: 'SAR' }; readonly returnUrl: string; readonly cancelUrl: string; readonly shopperHint?: { readonly applicantRef?: string } }

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlation(request);
  const merchant = merchantOr401(request, correlationId);
  if (merchant instanceof Response) return merchant;
  const key = request.headers.get('idempotency-key');
  if (key === null || !/^[0-9a-f-]{36}$/i.test(key)) return refuse(problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: 'A state-changing request requires an Idempotency-Key header carrying a UUID.', reason: 'IDEMPOTENCY_KEY_MISSING', correlationId }));
  // Sessions and idempotency keys are loaded from the database first: a replay must be recognised after a restart.
  await syncConsumerStore();
  const replay = sessionIdFor(merchant.merchantId, key);
  if (replay !== undefined) { const existing = findSession(replay); if (existing !== undefined) return json(201, toWire(existing, consumerBaseUrl(request)), correlationId, { 'idempotent-replay': 'true' }); }

  let parsed: unknown;
  try { parsed = await request.json(); } catch { return refuse(problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: 'The request body is not valid JSON.', reason: 'MALFORMED_JSON', correlationId })); }
  const failures = validate(parsed);
  if (failures.length > 0) {
    const unknown = failures.find((f) => f.unknownProperty !== undefined);
    return refuse(problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: unknown === undefined ? failures.map((f) => `${f.path || 'body'} ${f.message}`).join(' ') : 'Unknown property. The basket is the amount and the tenant’s catalogue is the terms; there is no field for a price.', reason: unknown === undefined ? 'SCHEMA_VALIDATION_FAILED' : 'UNKNOWN_PROPERTY', correlationId }));
  }
  const body = parsed as Body;
  // Read from the database now: a merchant suspended a moment ago in the workbench is refused here.
  await refreshMerchants();
  const record = merchantById(merchant.merchantId);
  if (record === undefined || !canTransact(record)) return refuse(problem({ status: 422, kind: 'control-rejection', title: 'Refused', detail: 'This merchant is not active.', reason: 'MERCHANT_NOT_ACTIVE', control: 'OP-DETERMINACY', correlationId }));

  const at = developmentAttestation();
  const created = create({ sessionId: randomUUID(), tenantId: merchant.tenantId, merchantId: merchant.merchantId, merchantOrderRef: body.merchantOrderRef, basket: money(BigInt(body.basket.minorUnits), body.basket.currency), productCode: 'bnpl', returnUrl: body.returnUrl, cancelUrl: body.cancelUrl, createdAt: at, expiresAtEpochSeconds: at.epochSeconds + SESSION_TTL_SECONDS, correlationId });
  if (!created.ok) return refuse(fromRejection(created.error, correlationId));
  saveSession(created.value);
  rememberIdempotency(merchant.merchantId, key, created.value.core.sessionId);
  // Durable before it is acknowledged: the merchant is told 201 only once the session and its key are stored.
  await flushConsumerStore();
  return json(201, toWire(created.value, consumerBaseUrl(request)), correlationId, { location: `/checkout/v1/sessions/${created.value.core.sessionId}` });
}
