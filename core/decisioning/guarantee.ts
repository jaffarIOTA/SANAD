/**
 * A partial credit guarantee from a public programme (such as the national SME
 * loan guarantee programme; the tenant's configuration names it). Coverage
 * differs by programme and initiative, so it is tenant
 * configuration with a reference to the programme document, never a constant.
 * Product-agnostic: any product a programme can guarantee uses this.
 */

import { type Result, ok, reject } from '../kernel/result.ts';

export interface GuaranteeTerms {
  readonly programme: string;
  /** Share of the financing the programme guarantees, per ten thousand. */
  readonly coveragePerTenThousand: number;
  /** The programme document and initiative the coverage comes from. Required. */
  readonly programmeRef: string;
  /** Whether the guarantee must be issued before disbursement. */
  readonly requiredBeforeDisbursement: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseGuarantee(raw: unknown): Result<GuaranteeTerms | undefined> {
  const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);
  if (raw === undefined) return ok(undefined);
  if (!isRecord(raw)) return bad('TERMS_GUARANTEE', 'guarantee is an object when present');
  const allowed = new Set(['programme', 'coveragePerTenThousand', 'programmeRef', 'requiredBeforeDisbursement']);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0)
    return reject('OP-DETERMINACY', 'TERMS_GUARANTEE_UNKNOWN_KEY', 'Unknown key in the guarantee terms', {
      keys: unknown.join(','),
    });
  if (typeof raw['programme'] !== 'string' || raw['programme'].trim().length === 0)
    return bad('TERMS_GUARANTEE_PROGRAMME', 'guarantee.programme names the programme');
  const coverage = raw['coveragePerTenThousand'];
  if (typeof coverage !== 'number' || !Number.isInteger(coverage) || coverage <= 0 || coverage > 10_000)
    return bad('TERMS_GUARANTEE_COVERAGE', 'guarantee.coveragePerTenThousand is a whole number in (0, 10000]');
  if (typeof raw['programmeRef'] !== 'string' || raw['programmeRef'].trim().length < 10)
    return bad(
      'TERMS_GUARANTEE_REF',
      'guarantee.programmeRef cites the programme document and initiative the coverage comes from',
    );
  if (typeof raw['requiredBeforeDisbursement'] !== 'boolean')
    return bad('TERMS_GUARANTEE_TIMING', 'guarantee.requiredBeforeDisbursement is a boolean');
  return ok({
    programme: raw['programme'],
    coveragePerTenThousand: coverage,
    programmeRef: raw['programmeRef'],
    requiredBeforeDisbursement: raw['requiredBeforeDisbursement'],
  });
}
