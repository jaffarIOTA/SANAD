import { describe, expect, it } from 'vitest';

import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { raise, submitForReview, type Principal } from '@sanad/core/origination/request.ts';
import { tsaInstant, elapsedSeconds } from '@sanad/core/time/tsa.ts';
import { decodeRequest, encodeRequest } from '../../services/origination/src/codec.ts';

const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });

describe('store codec', () => {
  it('round-trips a request with its amounts and attested instants intact', () => {
    const policy = expectOk(loadOriginationPolicy('bank-a'));
    const maker: Principal = { principalId: 'stf-maker-01', tenantId: 'bank-a' };
    const request = expectOk(submitForReview(expectOk(raise({ core: {
      requestId: 'req-c', tenantId: 'bank-a', programmeId: 'prg-0001', counterpartyId: 'cp', channel: 'MAKER_CHECKER',
      identification: { kind: 'STAFF_PRINCIPAL', principalId: 'stf-maker-01' },
      tradeReference: { type: 'CLEARED_INVOICE', invoiceUuid: 'u', invoiceHash: 'h', issuerCr: '1010000002', recipientCr: '7001000001' },
      requestedAmount: money(12_345_678_901_234n), requestedTenorDays: 60, correlationId: 'c', raisedAt: at(1_000),
    }, maker, policy })), at(1_100)));
    const back = decodeRequest(encodeRequest(request));
    expect(back).toEqual(request);
    expect(back.core.requestedAmount.minorUnits).toBe(12_345_678_901_234n);
    // The instant came back branded: the time helpers accept it.
    expect(elapsedSeconds(back.core.raisedAt, at(1_500))).toBe(500n);
  });
  it('does not mistake an ordinary object with a $bigint key among others for a number', () => {
    const odd = { $bigint: '5', other: 1 };
    expect(decodeRequest(JSON.stringify({ state: 'X', odd }) as string) as unknown).toEqual({ state: 'X', odd });
  });
});
