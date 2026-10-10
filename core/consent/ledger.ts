/**
 * A consent ledger over consent records (`core/ports/consent-ledger.ts`).
 *
 * The rules are `validConsent`'s, applied to one named consent: it must exist,
 * be a grant (not a withdrawal), not be withdrawn or expired at the ledger's
 * attested instant, have been granted already, be of the purpose asked and
 * belong to the tenant asking. Every refusal carries the same control; the
 * reason says which rule, for the audit trail, and never the consent's content.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { ConsentLedger, ConsentQuery } from '../ports/consent-ledger.ts';
import type { TsaInstant } from '../time/tsa.ts';

import type { ConsentRecord } from './consent.ts';

const refuse = (reason: string, query: ConsentQuery): Result<never> =>
  reject('OP-DETERMINACY', reason, 'No live consent for this purpose is on record for this tenant', {
    type: query.type,
  });

export function consentLedger(
  records: () => readonly ConsentRecord[] | Promise<readonly ConsentRecord[]>,
  now: () => Promise<TsaInstant>,
): ConsentLedger {
  return {
    async live(query) {
      if (query.consentId.trim().length === 0) return refuse('CONSENT_MISSING', query);
      const all = await records();
      const record = all.find((r) => r.consentId === query.consentId && r.withdraws === undefined);
      if (record === undefined) return refuse('CONSENT_NOT_FOUND', query);
      if (record.tenantId !== query.tenantId) return refuse('CONSENT_NOT_FOUND', query);
      if (record.type !== query.type) return refuse('CONSENT_WRONG_PURPOSE', query);
      const at = (await now()).epochSeconds;
      if (record.grantedAt.epochSeconds > at) return refuse('CONSENT_NOT_YET_GRANTED', query);
      if (record.expiresAt !== undefined && record.expiresAt.epochSeconds <= at)
        return refuse('CONSENT_EXPIRED', query);
      const withdrawn = all.some(
        (r) => r.withdraws === record.consentId && r.withdrawnAt !== undefined && r.withdrawnAt.epochSeconds <= at,
      );
      if (withdrawn) return refuse('CONSENT_WITHDRAWN', query);
      return ok(record);
    },
  };
}
