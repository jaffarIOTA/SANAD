/**
 * Booking a disbursed business loan in the loan system (UAE M6). Each case
 * attempts something booking forbids — booking before disbursement, booking
 * twice — and passes only when it is refused; a disbursed loan is booked once
 * and its loan account number recorded. The loan system is the demonstration
 * transport, labelled Fixture, as on the synthetic site.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { SEED_PRINCIPALS, type BusinessApplicationView, listApplications, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import { bookInLoanSystem } from '../../apps/ops/src/server/business-booking.ts';

const TENANT = 'sme-fund-ae' as const;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
let views: readonly BusinessApplicationView[] = [];
const withStatus = (s: string) => views.find((v) => v.application.status === s)?.application.applicationId ?? '';

beforeEach(async () => {
  resetBusinessStore();
  views = await listApplications(TENANT);
});

describe('booking in the loan system', () => {
  it('books a disbursed loan once and records its loan account number', async () => {
    const id = withStatus('DISBURSED');
    const booked = expectOk(await bookInLoanSystem(TENANT, id, SEED_PRINCIPALS.finance));
    expect(booked.booking).toMatchObject({ source: 'FIXTURE', productCode: 'SME FINANCE AED', bookedBy: SEED_PRINCIPALS.finance });
    expect(booked.booking?.loanAccountNumber).toMatch(/^DEMO-\d{7}$/);
    expect(booked.events.some((e) => e.eventType === 'LOAN_BOOKED')).toBe(true);
    expect(reason(await bookInLoanSystem(TENANT, id, SEED_PRINCIPALS.finance))).toBe('LOAN_ALREADY_BOOKED');
  });

  it('a loan not yet disbursed is not booked', async () => {
    expect(reason(await bookInLoanSystem(TENANT, withStatus('OFFER_SENT'), SEED_PRINCIPALS.finance))).toBe('TRANSITION_NOT_ALLOWED');
  });
});
