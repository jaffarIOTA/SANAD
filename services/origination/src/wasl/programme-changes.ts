/**
 * The check a change to the programmes must pass (Wasl W5b), at proposal and
 * again at approval, because exposure may move in between:
 *
 *   - a programme is not removed while a transaction or a facility refers to it;
 *   - a programme that has traded keeps its anchor — the invoices it financed
 *     were issued by that anchor, and the seller is paid at its account (SH-08);
 *   - a limit is never set below what the programme holds, nor below any
 *     facility in it (a facility is never larger than its programme).
 *
 * A new anchor account (IBAN) on an existing anchor is allowed: four eyes is
 * the control on it, and the next seller payment goes to the account in force.
 */
import type { TenantCode, WaslProgramme } from '@sanad/config/loader.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

import { hydrate } from './book.ts';
import { resolveWaslParties } from './configuration.ts';
import { exposureOf } from './exposure.ts';
import { facilitiesFrom, facilityApprovals } from './facilities.ts';

const refuse = (reason: string, detail: string, programmeId: string): Result<never> =>
  reject('OP-LIMIT', reason, detail, { programmeId });

/** Whether the proposed programmes may replace those in force. The first conflict refuses the change. */
export async function checkProgrammesChange(
  tenant: TenantCode,
  proposed: readonly WaslProgramme[],
): Promise<Result<true>> {
  const parties = await resolveWaslParties(tenant);
  if (!parties.ok) return parties;
  const book = [...(await hydrate(tenant)).records.values()];
  const facilities = facilitiesFrom(await facilityApprovals(tenant));
  for (const current of parties.value.programmes) {
    const id = current.programmeId;
    const next = proposed.find((p) => p.programmeId === id);
    const traded = book.some((r) => r.transaction.core.programmeId === id);
    const inProgramme = facilities.filter((f) => f.programmeId === id);
    if (next === undefined) {
      if (traded || inProgramme.length > 0)
        return refuse('PROGRAMME_IN_USE', 'A programme with transactions or facilities is not removed', id);
      continue;
    }
    if (traded && next.anchor.registrationNo !== current.anchor.registrationNo)
      return refuse('ANCHOR_IN_USE', 'A programme that has traded keeps its anchor', id);
    const held = exposureOf(book, parties.value, '', id).programmeHeld;
    if (next.programmeLimitMinorUnits < held)
      return refuse('PROGRAMME_LIMIT_BELOW_EXPOSURE', 'The programme already holds more than this limit', id);
    if (inProgramme.some((f) => f.limit.minorUnits > next.programmeLimitMinorUnits))
      return refuse('PROGRAMME_LIMIT_BELOW_FACILITY', 'A facility in this programme is larger than this limit', id);
  }
  return ok(true);
}
