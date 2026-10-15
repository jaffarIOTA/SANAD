/**
 * Closing a business application (UAE M5a): signing through the identity
 * service, conditions precedent, the payee account. Each case attempts
 * something closing forbids and passes only when it is refused: a payee in
 * the wrong country, confirming one's own payee, releasing a payment to an
 * account one recorded, disbursing without a confirmed payee, changing
 * closing after disbursement. The signing runs on the demonstration
 * transport, labelled Fixture, as on the synthetic site.
 *
 * The book is the service's in-memory seed for sme-fund-ae.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  SEED_PRINCIPALS,
  type BusinessApplicationView,
  confirmPayee,
  listApplications,
  recordDisbursed,
  recordPayee,
  recordSigned,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';
import { confirmSigning, startSigning } from '../../apps/ops/src/server/business-signing.ts';
import { EXAMPLE_AE_IBAN } from '../support/business-closing.ts';

const TENANT = 'sme-fund-ae' as const;
const { officer, checker, finance } = SEED_PRINCIPALS;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);

let views: readonly BusinessApplicationView[] = [];
const withStatus = (s: string) => {
  const v = views.find((x) => x.application.status === s);
  if (v === undefined) throw new Error(`no seed in ${s}`);
  return v;
};

beforeEach(async () => {
  resetBusinessStore();
  views = await listApplications(TENANT);
});

describe('signing through the identity service', () => {
  it('opens on the sent letter’s fingerprint and records the signature only when the service confirms it', async () => {
    const sent = withStatus('OFFER_SENT');
    const id = sent.application.applicationId;
    expect(reason(await confirmSigning(TENANT, id, officer))).toBe('SIGNING_NOT_STARTED');
    const opened = expectOk(await startSigning(TENANT, id, officer));
    expect(opened.closing.signing).toMatchObject({ letterVersion: sent.application.offer?.letterVersion, source: 'FIXTURE' });
    const signed = expectOk(await confirmSigning(TENANT, id, officer));
    expect(signed.application.status).toBe('SIGNED');
    expect(signed.application.signature?.signatureRef).toMatch(/^uaepass:/);
    expect(signed.closing.signer?.source).toBe('FIXTURE');
    expect(signed.closing.signing).toBeUndefined();
  });
});

describe('the payee account', () => {
  it('is an IBAN of the institution’s country, proven by a document on the application', async () => {
    const v = withStatus('OFFER_SENT');
    const id = v.application.applicationId;
    const doc = v.documents[0]?.documentRef ?? '';
    expect(reason(await recordPayee(TENANT, id, { iban: 'SA0380000000608010167519', accountName: 'X LLC', evidenceRef: doc }, officer))).toBe(
      'IBAN_INVALID',
    );
    expect(reason(await recordPayee(TENANT, id, { iban: EXAMPLE_AE_IBAN, accountName: 'X LLC', evidenceRef: 'doc-nowhere' }, officer))).toBe(
      'SECURITY_EVIDENCE_NOT_ON_FILE',
    );
    expectOk(await recordPayee(TENANT, id, { iban: 'ae07 0331 2345 6789 0123 456', accountName: 'X LLC', evidenceRef: doc }, officer));
  });

  it('whoever recorded it neither confirms it nor releases a payment to it', async () => {
    const v = withStatus('OFFER_SENT');
    const id = v.application.applicationId;
    const doc = v.documents[0]?.documentRef ?? '';
    // The finance user records the account themselves…
    expectOk(await recordPayee(TENANT, id, { iban: EXAMPLE_AE_IBAN, accountName: 'X LLC', evidenceRef: doc }, finance));
    expect(reason(await confirmPayee(TENANT, id, finance))).toBe('FOUR_EYES_SELF_CONFIRMATION');
    expectOk(await confirmPayee(TENANT, id, checker));
    expectOk(await recordSigned(TENANT, id, { letterVersion: v.application.offer?.letterVersion ?? '' }, officer));
    // …and so may not release the payment to it.
    expect(reason(await recordDisbursed(TENANT, id, finance))).toBe('FOUR_EYES_PAYEE');
  });

  it('a signed facility is not disbursed without a confirmed payee', async () => {
    const v = withStatus('OFFER_SENT');
    const id = v.application.applicationId;
    expectOk(await recordSigned(TENANT, id, { letterVersion: v.application.offer?.letterVersion ?? '' }, officer));
    expect(reason(await recordDisbursed(TENANT, id, finance))).toBe('PAYEE_NOT_CONFIRMED');
  });

  it('every disbursed seed paid a confirmed IBAN; nothing in closing changes after disbursement', async () => {
    const paid = views.filter((x) => x.application.status === 'DISBURSED');
    expect(paid.length).toBeGreaterThan(0);
    for (const p of paid) {
      expect(p.closing.payee?.confirmedBy).toBeDefined();
      expect(p.closing.payee?.confirmedBy).not.toBe(p.closing.payee?.recordedBy);
    }
    const id = paid[0]?.application.applicationId ?? '';
    const doc = paid[0]?.documents[0]?.documentRef ?? '';
    expect(reason(await recordPayee(TENANT, id, { iban: EXAMPLE_AE_IBAN, accountName: 'X LLC', evidenceRef: doc }, officer))).toBe(
      'CLOSING_LOCKED',
    );
  });
});
// Conditions precedent gating drawdown, evidenced and verified by two people: business-approved-terms.test.ts, end to end.
