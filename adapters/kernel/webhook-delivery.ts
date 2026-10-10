/**
 * Webhook delivery to a partner's registered endpoint, signed (SR-016).
 *
 * The body is serialised once and the signature is over exactly those bytes,
 * so what the receiver verifies is what it parses. The partner's endpoint and
 * signing secret come from the tenant's registration and the vault, resolved
 * by reference; neither is logged or returned. Only https endpoints.
 *
 * A 2xx is delivered; a 4xx is the partner refusing (not retried as if it
 * were down); anything else, or no answer, is UNAVAILABLE and the outbox
 * retries it under the same idempotency key.
 */

import { type Result, ok, reject } from '../../core/kernel/result.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import type { WebhookDelivery, WebhooksPort } from '../../core/ports/webhooks.ts';

import { SIGNATURE_HEADER, signWebhook } from './webhook-signature.ts';

export interface WebhookEndpoint {
  readonly url: string;
  readonly secret: Uint8Array;
}

export interface WebhookDeliveryOptions {
  /** The partner's registered endpoint and signing secret, or undefined when it has none. */
  readonly endpoint: (tenantId: string, partnerRef: string) => Promise<WebhookEndpoint | undefined>;
  readonly nowEpochSeconds: () => bigint;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function signedWebhooks(o: WebhookDeliveryOptions): WebhooksPort {
  const doFetch = o.fetchImpl ?? fetch;
  return {
    async deliver(
      d: WebhookDelivery,
    ): Promise<Result<RailOutcome<{ readonly deliveryRef: string; readonly statusCode: number }>>> {
      const endpoint = await o.endpoint(d.tenantId, d.partnerRef);
      if (endpoint === undefined)
        return reject('OP-DETERMINACY', 'WEBHOOK_NOT_REGISTERED', 'The partner has no registered webhook endpoint', {
          partnerRef: d.partnerRef,
        });
      if (!endpoint.url.startsWith('https://'))
        return reject('OP-DETERMINACY', 'WEBHOOK_ENDPOINT_INSECURE', 'A webhook endpoint must be https', {
          partnerRef: d.partnerRef,
        });
      const rawBody = JSON.stringify({ event: d.event, ...d.payload });
      const signature = signWebhook(endpoint.secret, rawBody, o.nowEpochSeconds());
      let status: number;
      try {
        const r = await doFetch(endpoint.url, {
          method: 'POST',
          body: rawBody,
          redirect: 'error',
          signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
          headers: {
            'content-type': 'application/json',
            [SIGNATURE_HEADER]: signature,
            'idempotency-key': d.idempotencyKey,
            'x-correlation-id': d.correlationId,
          },
        });
        status = r.status;
      } catch {
        return ok({ kind: 'UNAVAILABLE', reason: 'the partner endpoint did not answer' });
      }
      if (status >= 200 && status < 300)
        return ok({ kind: 'ANSWERED', value: { deliveryRef: d.idempotencyKey, statusCode: status } });
      if (status >= 400 && status < 500 && status !== 408 && status !== 429)
        return ok({ kind: 'REFUSED', code: `HTTP_${String(status)}` });
      return ok({ kind: 'UNAVAILABLE', reason: `the partner endpoint answered ${String(status)}` });
    },
  };
}
