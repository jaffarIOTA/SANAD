/**
 * Justifies every deviation the assessment recorded, through the public
 * service, as credit would before the committee sits (UAE M4). The justifier
 * must not be the committee member who then approves.
 */
import type { TenantCode } from '../../config/loader.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { decisionPack, justifyDeviation } from '../../apps/ops/src/server/business.ts';

export async function justifyDeviations(tenant: TenantCode, applicationId: string, by: string): Promise<void> {
  const pack = expectOk(await decisionPack(tenant, applicationId));
  for (const d of pack.deviations)
    if (d.justification === undefined)
      expectOk(await justifyDeviation(tenant, applicationId, d.code, 'Mitigated by the confirmed security and guarantees', by));
}
