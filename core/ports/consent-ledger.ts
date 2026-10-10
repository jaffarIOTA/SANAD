/**
 * Consent ledger.
 *
 * The question every consent-gated rail asks before it calls out: is this
 * consent live, for this purpose, for this tenant, now? A rail adapter answers
 * it here rather than trusting that a non-empty id means a recorded consent
 * (SR-026). The ledger reads its own trusted time; the caller never supplies
 * the instant it is judged at.
 */

import type { ConsentRecord, ConsentType } from '../consent/consent.ts';
import type { Result } from '../kernel/result.ts';

export interface ConsentQuery {
  readonly tenantId: string;
  readonly consentId: string;
  readonly type: ConsentType;
}

export interface ConsentLedger {
  /** The live grant, or a refusal: unknown, withdrawn, expired, another purpose or another tenant. */
  live(query: ConsentQuery): Promise<Result<ConsentRecord>>;
}
