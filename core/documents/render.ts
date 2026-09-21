/**
 * Document rendering requests.
 *
 * One leg, one document. The request type below holds a single leg — not an
 * array, not an optional second leg — so "render the offer and the acceptance
 * together to save a signature ceremony" is not a request this system can
 * express (SH-07, SDD §6.8).
 *
 * The runtime guard exists as well, for callers assembling a request from
 * untyped input at a service boundary. Belt and braces: the constraint also
 * exists in the database as a uniqueness constraint on the document reference.
 */

import type { ContractLeg } from '../legs/leg.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export type RenderLocale = 'ar-SA' | 'en-SA';

export interface LegRenderRequest {
  readonly requestId: string;
  readonly tenantId: string;
  /** Singular, and deliberately so. */
  readonly leg: ContractLeg;
  /** Resolved to an explicit approved version. Never "latest". */
  readonly templateVersionId: string;
  /** Arabic is the governing text; English accompanies it as a translation. */
  readonly governingLocale: 'ar-SA';
  readonly translationLocale: RenderLocale;
  /** Merge values for the declared variable fields only. */
  readonly mergeFields: Readonly<Record<string, string>>;
  readonly shariahApprovalId: string;
  readonly correlationId: string;
}

/**
 * Build a request from an untyped list of legs. Accepts exactly one.
 *
 * This is the guard rail at the service boundary that SDD §6.8 calls for: the
 * document service refuses to render two legs into one instrument rather than
 * relying on callers to know better.
 */
export function buildLegRenderRequest(
  legs: readonly ContractLeg[],
  params: Omit<LegRenderRequest, 'leg' | 'governingLocale'> & {
    readonly governingLocale?: 'ar-SA';
  },
): Result<LegRenderRequest> {
  if (legs.length === 0) {
    return reject('SH-07', 'NO_LEG_SUPPLIED', 'A document must render exactly one contractual leg');
  }
  if (legs.length > 1) {
    return reject(
      'SH-07',
      'COMBINED_LEG_RENDERING_REFUSED',
      'Each leg is a distinct instrument with its own execution event and timestamp; two legs cannot be rendered into one document',
      { legCount: legs.length, legIds: legs.map((l) => l.legId).join(',') },
    );
  }

  const leg = legs[0];
  if (leg === undefined) {
    return reject('SH-07', 'NO_LEG_SUPPLIED', 'A document must render exactly one contractual leg');
  }

  if (params.templateVersionId.length === 0) {
    return reject(
      'SH-17',
      'TEMPLATE_VERSION_UNRESOLVED',
      'Rendering is always against an explicit approved template version',
    );
  }

  return ok({
    requestId: params.requestId,
    tenantId: params.tenantId,
    leg,
    templateVersionId: params.templateVersionId,
    governingLocale: 'ar-SA',
    translationLocale: params.translationLocale,
    mergeFields: params.mergeFields,
    shariahApprovalId: params.shariahApprovalId,
    correlationId: params.correlationId,
  });
}
