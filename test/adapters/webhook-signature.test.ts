/**
 * SR-016: webhooks are signed going out, and verified coming in before the
 * body is parsed. Each refusal case attempts what an attacker would: no
 * signature, an altered body, the wrong secret, a stale timestamp, a replay.
 */
import { describe, expect, it } from 'vitest';

import { signedWebhooks } from '../../adapters/kernel/webhook-delivery.ts';
import {
  SIGNATURE_HEADER,
  type SignatureReplayGuard,
  signWebhook,
  verifyWebhook,
} from '../../adapters/kernel/webhook-signature.ts';
import { expectOk } from '../../core/kernel/result.ts';

const SECRET = new Uint8Array(Buffer.from('a7'.repeat(32), 'hex'));
const OTHER = new Uint8Array(Buffer.from('b8'.repeat(32), 'hex'));
const NOW = 1_800_000_000n;
const BODY = '{"eventId":"e-1","sequence":1}';

const guard = (): SignatureReplayGuard => {
  const seen = new Set<string>();
  return {
    firstUse: (s) => {
      if (seen.has(s)) return Promise.resolve(false);
      seen.add(s);
      return Promise.resolve(true);
    },
  };
};
const check = (header: string | undefined, over: { body?: string; now?: bigint; replay?: SignatureReplayGuard } = {}) =>
  verifyWebhook({
    header,
    rawBody: over.body ?? BODY,
    secrets: [SECRET],
    nowEpochSeconds: over.now ?? NOW,
    replay: over.replay ?? guard(),
  });
const reasonOf = async (p: ReturnType<typeof check>) => {
  const r = await p;
  return r.ok ? 'OK' : r.reason;
};

describe('inbound webhooks verify before parsing (SR-016)', () => {
  it('accepts a body signed with the secret, within the window', async () => {
    expect(await reasonOf(check(signWebhook(SECRET, BODY, NOW - 10n)))).toBe('OK');
  });

  it('refuses an unsigned body, a malformed header, an altered body and the wrong secret', async () => {
    expect(await reasonOf(check(undefined))).toBe('SIGNATURE_MISSING');
    expect(await reasonOf(check('v1=abc'))).toBe('SIGNATURE_MALFORMED');
    expect(await reasonOf(check(signWebhook(SECRET, BODY, NOW), { body: BODY.replace('1}', '2}') }))).toBe(
      'SIGNATURE_INVALID',
    );
    expect(await reasonOf(check(signWebhook(OTHER, BODY, NOW)))).toBe('SIGNATURE_INVALID');
  });

  it('refuses a timestamp moved into the window, and one outside it', async () => {
    const old = signWebhook(SECRET, BODY, NOW - 3_600n);
    expect(await reasonOf(check(old))).toBe('TIMESTAMP_OUTSIDE_TOLERANCE');
    // The timestamp is inside the MAC: rewriting it breaks the signature.
    expect(await reasonOf(check(old.replace(`t=${(NOW - 3_600n).toString()}`, `t=${NOW.toString()}`)))).toBe(
      'SIGNATURE_INVALID',
    );
  });

  it('refuses a replay of a delivery already accepted', async () => {
    const replay = guard();
    const header = signWebhook(SECRET, BODY, NOW);
    expect(await reasonOf(check(header, { replay }))).toBe('OK');
    expect(await reasonOf(check(header, { replay }))).toBe('REPLAYED');
  });

  it('accepts either secret while one rotates', async () => {
    const r = await verifyWebhook({
      header: signWebhook(OTHER, BODY, NOW),
      rawBody: BODY,
      secrets: [SECRET, OTHER],
      nowEpochSeconds: NOW,
      replay: guard(),
    });
    expect(r.ok).toBe(true);
  });
});

describe('outbound webhooks carry Sanad-Signature over the exact bytes sent (SR-016)', () => {
  const delivery = {
    tenantId: 'bank-a',
    partnerRef: 'partner-01',
    event: 'requestStateChanged',
    payload: { eventId: 'e-9', sequence: 3 },
    idempotencyKey: 'idem-9',
    correlationId: 'cor-9',
  };

  it('signs what it sends, so the receiver verifies it', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const port = signedWebhooks({
      endpoint: () => Promise.resolve({ url: 'https://partner.example/hooks', secret: SECRET }),
      nowEpochSeconds: () => NOW,
      fetchImpl: (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    expect(expectOk(await port.deliver(delivery)).kind).toBe('ANSWERED');
    const headers = sent[0]?.init.headers as Record<string, string>;
    const verified = await verifyWebhook({
      header: headers[SIGNATURE_HEADER],
      rawBody: sent[0]?.init.body as string,
      secrets: [SECRET],
      nowEpochSeconds: NOW,
      replay: guard(),
    });
    expect(verified.ok).toBe(true);
    expect(headers['idempotency-key']).toBe('idem-9');
  });

  it('refuses an http endpoint and an unregistered partner; a partner error is not retried as an outage', async () => {
    const at = (url: string | undefined, status = 204) =>
      signedWebhooks({
        endpoint: () => Promise.resolve(url === undefined ? undefined : { url, secret: SECRET }),
        nowEpochSeconds: () => NOW,
        fetchImpl: () => Promise.resolve(new Response(null, { status })),
      }).deliver(delivery);
    expect((await at('http://partner.example/hooks')).ok).toBe(false);
    expect((await at(undefined)).ok).toBe(false);
    expect(expectOk(await at('https://partner.example/hooks', 400)).kind).toBe('REFUSED');
    expect(expectOk(await at('https://partner.example/hooks', 503)).kind).toBe('UNAVAILABLE');
  });
});
