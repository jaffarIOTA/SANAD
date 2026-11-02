/**
 * The security register on a business application (UAE M3). Each case
 * attempts something the journey forbids and passes only when it is refused:
 * confirming one's own entry, submitting without the security the product
 * requires, counting a stale valuation, naming evidence that is not on file,
 * changing the register after submission.
 *
 * The book is the service's in-memory seed for sme-fund-ae.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  type BusinessApplicationView,
  confirmSecurityItem,
  listApplications,
  presentDocument,
  recordCollateral,
  recordGuarantee,
  resetBusinessStore,
  securityStatus,
  withdrawSecurityItem,
} from '../../apps/ops/src/server/business.ts';

const TENANT = 'sme-fund-ae' as const;
const NOW = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86_400n;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);

let views: readonly BusinessApplicationView[] = [];
const withStatus = (...s: string[]) => {
  const v = views.find((x) => s.includes(x.application.status));
  if (v === undefined) throw new Error(`no seed in ${s.join('/')}`);
  return v.application.applicationId;
};
const vehicle = (over: Record<string, unknown> = {}) => ({
  kind: 'VEHICLE',
  description: 'Delivery van',
  marketValueMinorUnits: 90_000_00n,
  valuedAtEpochSeconds: NOW - DAY,
  valuerRef: 'valuer-1',
  charge: 'NOT_APPLICABLE',
  ...over,
});

beforeEach(async () => {
  resetBusinessStore();
  views = await listApplications(TENANT);
});

describe('four eyes on the register', () => {
  it('whoever recorded an item does not confirm it; a different person does', async () => {
    const id = withStatus('RECEIVED', 'SPREADING');
    const v = expectOk(await recordCollateral(TENANT, id, vehicle(), 'officer-1'));
    const itemId = v.security.collateral.at(-1)?.itemId ?? '';
    expect(reason(await confirmSecurityItem(TENANT, id, itemId, 'officer-1'))).toBe('FOUR_EYES_SELF_CONFIRMATION');
    const confirmed = expectOk(await confirmSecurityItem(TENANT, id, itemId, 'checker-1'));
    expect(confirmed.security.collateral.at(-1)?.confirmedBy).toBe('checker-1');
    expect(reason(await confirmSecurityItem(TENANT, id, itemId, 'checker-2'))).toBe('SECURITY_ALREADY_CONFIRMED');
  });

  it('an unconfirmed item counts for nothing', async () => {
    const id = withStatus('RECEIVED', 'SPREADING');
    expectOk(await recordCollateral(TENANT, id, vehicle(), 'officer-1'));
    const s = expectOk(await securityStatus(TENANT, id));
    expect(s.position.lendingValue.minorUnits).toBe(0n);
    expect(s.position.awaitingConfirmation).toBe(1);
  });
});

describe('what may be recorded', () => {
  it('refuses evidence that is not a document on the application', async () => {
    const id = withStatus('RECEIVED', 'SPREADING');
    expect(reason(await recordCollateral(TENANT, id, vehicle({ evidenceRef: 'doc-elsewhere' }), 'officer-1'))).toBe(
      'SECURITY_EVIDENCE_NOT_ON_FILE',
    );
    expectOk(await presentDocument(TENANT, id, { documentType: 'ASSET_VALUATION_REPORT', documentRef: 'doc-val-1' }, 'officer-1'));
    expectOk(await recordCollateral(TENANT, id, vehicle({ evidenceRef: 'doc-val-1' }), 'officer-1'));
  });

  it('refuses a personal guarantee from someone who is not an owner, and a second one from the same owner', async () => {
    const id = withStatus('RECEIVED', 'SPREADING');
    const owner = views.find((v) => v.application.applicationId === id)?.application.applicant.owners[0]?.ref ?? '';
    expect(
      reason(await recordGuarantee(TENANT, id, { guarantorKind: 'PERSONAL', guarantorRef: 'stranger-1', guarantorName: '' }, 'officer-1')),
    ).toBe('GUARANTOR_NOT_AN_OWNER');
    expectOk(await recordGuarantee(TENANT, id, { guarantorKind: 'PERSONAL', guarantorRef: owner, guarantorName: '' }, 'officer-1'));
    expect(
      reason(await recordGuarantee(TENANT, id, { guarantorKind: 'PERSONAL', guarantorRef: owner, guarantorName: '' }, 'officer-1')),
    ).toBe('GUARANTEE_DUPLICATE');
  });

  it('a withdrawn item cannot be confirmed afterwards', async () => {
    const id = withStatus('RECEIVED', 'SPREADING');
    const itemId = expectOk(await recordCollateral(TENANT, id, vehicle(), 'officer-1')).security.collateral.at(-1)?.itemId ?? '';
    expectOk(await withdrawSecurityItem(TENANT, id, itemId, 'officer-1'));
    expect(reason(await confirmSecurityItem(TENANT, id, itemId, 'checker-1'))).toBe('SECURITY_ITEM_WITHDRAWN');
  });

  it('a valuation older than the policy allows is not confirmed', async () => {
    const id = withStatus('RECEIVED', 'SPREADING');
    const itemId =
      expectOk(await recordCollateral(TENANT, id, vehicle({ valuedAtEpochSeconds: NOW - 400n * DAY }), 'officer-1')).security.collateral.at(-1)
        ?.itemId ?? '';
    expect(reason(await confirmSecurityItem(TENANT, id, itemId, 'checker-1'))).toBe('VALUATION_STALE');
  });
});

describe('the register and the journey', () => {
  it('nothing in the register changes once the application is submitted', async () => {
    const id = withStatus('SUBMITTED', 'ASSESSED', 'IN_COMMITTEE');
    expect(reason(await recordCollateral(TENANT, id, vehicle(), 'officer-1'))).toBe('SECURITY_LOCKED');
    const seeded = views.find((v) => v.application.applicationId === id)?.security.collateral[0]?.itemId ?? 'COL-001';
    expect(reason(await withdrawSecurityItem(TENANT, id, seeded, 'officer-1'))).toBe('SECURITY_LOCKED');
  });

  it('every submitted seed carries the security its variant requires, confirmed by someone other than the recorder', async () => {
    for (const v of views.filter((x) => x.application.submittedAtEpochSeconds !== undefined)) {
      for (const item of [...v.security.collateral, ...v.security.guarantees]) {
        expect(item.confirmedBy).toBeDefined();
        expect(item.confirmedBy).not.toBe(item.recordedBy);
      }
      expect(v.security.guarantees.length).toBeGreaterThan(0);
    }
  });

  // Submission refused with SECURITY_INCOMPLETE when everything else is ready: business-approved-terms.test.ts.
});
