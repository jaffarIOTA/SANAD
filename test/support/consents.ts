/**
 * A consent ledger for adapter tests: the named consent ids are live for any
 * purpose, for one tenant. The real ledger's rules (expiry, withdrawal, purpose,
 * tenant) are tested in test/compliance/rail-consent.test.ts.
 */
import type { ConsentRecord } from '../../core/consent/consent.ts';
import { ok, reject } from '../../core/kernel/result.ts';
import type { ConsentLedger } from '../../core/ports/consent-ledger.ts';
import { tsaInstant } from '../../core/time/tsa.ts';

export function grantingLedger(tenantId: string, consentIds: readonly string[] = ['cns', 'cns-1']): ConsentLedger {
  return {
    live: (q) =>
      Promise.resolve(
        q.tenantId === tenantId && consentIds.includes(q.consentId)
          ? ok<ConsentRecord>({
              consentId: q.consentId,
              tenantId,
              counterpartyId: 'cp-test',
              type: q.type,
              version: 'v1',
              purpose: 'test',
              channel: 'PORTAL',
              evidenceRef: 'evidence-test',
              grantedAt: tsaInstant({ verified: true, genTimeEpochSeconds: 1n, tokenDigest: 't', authorityId: 'test' }),
            })
          : reject('OP-DETERMINACY', 'CONSENT_NOT_FOUND', 'No live consent', { type: q.type }),
      ),
  };
}
