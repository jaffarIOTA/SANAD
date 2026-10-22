/**
 * Approved facilities for the Wasl suites (W5a): no facility, no trade. Each
 * configured distributor is given a facility in each programme, proposed by
 * one person and approved by another, exactly as the workbench does — so a
 * suite about sequencing or settlement starts from a distributor that may draw.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { loadWaslParties } from '@sanad/config/loader.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  decideFacility,
  facilityApprovals,
  facilityFor,
  proposeFacility,
} from '../../services/origination/src/wasl/facilities.ts';

/** SAR 10 million: well inside each illustrative programme and its concentration share. */
export const TEST_FACILITY_MINOR = 1_000_000_000n;

export async function approveTestFacilities(tenant: TenantCode = 'bank-a', limit = TEST_FACILITY_MINOR): Promise<void> {
  const parties = expectOk(loadWaslParties(tenant));
  for (const programme of parties.programmes)
    for (const distributor of parties.distributors) {
      if ((await facilityFor(tenant, distributor.counterpartyId, programme.programmeId)) !== undefined) continue;
      const proposed = await proposeFacility(tenant, 'stf-credit-test', {
        counterpartyId: distributor.counterpartyId,
        programmeId: programme.programmeId,
        limitMinorUnits: limit,
        rationale: 'Test facility for the Wasl suites',
      });
      // Another suite on the same database may have proposed it a moment ago: approve that one instead.
      const open = proposed.ok
        ? proposed.value
        : (await facilityApprovals(tenant)).find(
            (a) =>
              a.state === 'PROPOSED' &&
              a.counterpartyId === distributor.counterpartyId &&
              a.programmeId === programme.programmeId,
          );
      if (open !== undefined)
        await decideFacility(tenant, 'stf-approver-test', { approvalId: open.approvalId, approve: true, note: '' });
      if ((await facilityFor(tenant, distributor.counterpartyId, programme.programmeId)) === undefined)
        throw new Error(`no facility for ${distributor.counterpartyId} in ${programme.programmeId}`);
    }
}
