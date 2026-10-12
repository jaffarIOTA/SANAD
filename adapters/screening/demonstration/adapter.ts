/**
 * The demonstration screening adapter.
 *
 * No screening vendor is chosen yet (sanctions, PEP and adverse media are
 * usually bought from one, not called from a government API). Until one is,
 * this adapter stands behind the screening port on the hosted synthetic
 * environment only, so an intake can be walked end to end. It answers by rule
 * and says so: every result it gives is labelled FIXTURE where it is shown.
 *
 * It does what a real screening adapter must do first: refuse a request
 * without a live screening consent for this tenant (SR-026), before anything
 * is "screened".
 *
 * The rule, so a demonstration can be steered from the form: a subject
 * reference containing "reject" is REJECTED on sanctions, one containing
 * "refer" is REFERRED on PEP, any other is CLEAR on every check.
 */

import type { Result } from '../../../core/kernel/result.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { ConsentLedger } from '../../../core/ports/consent-ledger.ts';
import type {
  ScreeningCheck,
  ScreeningOutcome,
  ScreeningPort,
  ScreeningRequest,
  ScreeningResult,
} from '../../../core/ports/screening.ts';
import type { TsaInstant } from '../../../core/time/tsa.ts';

export class DemonstrationScreening implements ScreeningPort {
  constructor(
    private readonly consents: ConsentLedger,
    private readonly attest: () => Promise<TsaInstant>,
  ) {}

  async screen(
    req: ScreeningRequest,
  ): Promise<Result<ScreeningResult | { readonly kind: 'UNAVAILABLE'; readonly reason: string }>> {
    const consent = await this.consents.live({ tenantId: req.tenantId, consentId: req.consentId, type: 'SCREENING' });
    if (!consent.ok) return consent;
    const subject = req.counterpartyId.toLowerCase();
    const hit = (check: ScreeningCheck): ScreeningOutcome => {
      if (check === 'SANCTIONS' && subject.includes('reject')) return 'REJECT';
      if (check === 'PEP' && subject.includes('refer')) return 'REFER';
      return 'CLEAR';
    };
    const perCheck = req.checks.map((check) => ({ check, outcome: hit(check) }));
    const overall: ScreeningOutcome = perCheck.some((c) => c.outcome === 'REJECT')
      ? 'REJECT'
      : perCheck.some((c) => c.outcome === 'REFER')
        ? 'REFER'
        : 'CLEAR';
    return ok({
      screeningReference: `scr-demo-${req.counterpartyId}`,
      screenedAt: await this.attest(),
      overall,
      perCheck,
    });
  }
}
