/**
 * The business server actions, called as a browser's form post would call
 * them (Next's redirect, revalidation and cookie jar stood in for), acting as
 * whoever holds the sealed staff session — never as a constant.
 *
 *  #1  a form that says sourceKind=OCR still records OFFICER_ENTRY by the
 *      signed-in officer, and the verifier is the signed-in checker, never a
 *      hidden field
 *  #16 a refusal redirects with the control and reason codes only — no free
 *      text in the URL for a screen to echo
 *  SEC-TM14 an act needing an authority the principal lacks is refused
 *  four eyes is between people: one signed-in person cannot key and verify,
 *      present and validate, or submit and decide
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name: string, value: string) => {
        jar.set(name, value);
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    }),
}));

import type { StaffAuthority } from '@sanad/core/config/staff-identity.ts';

import {
  READ_FIGURE_SOURCES,
  SEED_PRINCIPALS,
  getApplication,
  handOver,
  ingestReadFigures,
  listApplications,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';
import {
  approveStraightThroughAction,
  committeeDecisionAction,
  presentDocumentAction,
  proposeFigureAction,
  recordDisbursedAction,
  runAssessmentAction,
  submitForAssessmentAction,
  validateDocumentAction,
  verifyFigureAction,
  withdrawApplicationAction,
} from '../../apps/ops/src/server/business-actions.ts';
import { STAFF_SESSION_COOKIE, epochNow, issueStaffSession } from '../../apps/ops/src/server/staff-session.ts';

const TENANT = 'sme-fund-ae' as const;
const ID = 'FR-00009101';

/** Sign a fictional person in: the cookie a real sign-in would set. */
function signIn(
  principalId: string,
  authorities: readonly StaffAuthority[],
  tenantId: 'sme-fund-ae' | 'bank-a' = TENANT,
): void {
  jar.set(STAFF_SESSION_COOKIE, issueStaffSession({ principalId, tenantId, authorities }, 1_800n, epochNow()).token);
}
const OFFICER = (): void => signIn('stf-ae-officer-01', ['MAKER']);
const CHECKER = (): void => signIn('stf-ae-checker-01', ['CHECKER']);

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ locale: 'en', applicationId: ID, ...fields })) f.set(k, v);
  return f;
};

/** Run an action; return the URL it redirected to. */
async function redirectOf(action: (f: FormData) => Promise<void>, f: FormData): Promise<URL> {
  try {
    await action(f);
  } catch (error) {
    const url = (error as { url?: string }).url;
    if (url !== undefined) return new URL(url, 'http://ops.test');
    throw error;
  }
  throw new Error('the action did not redirect');
}

async function handOverTestApplication(): Promise<void> {
  const r = await handOver(
    TENANT,
    {
      applicationId: ID,
      upstreamRef: 'upstream-actions-9101',
      applicant: {
        businessNameEn: 'Actions Test LLC',
        registrationRef: 'TL-ACT-9101',
        sector: 'TRADING',
        yearsInOperation: 4,
        owners: [{ displayName: 'Actions Owner Example', ref: 'owner-act-9101' }],
        upstreamVerificationRefs: ['uaepass:assert-act'],
      },
      productCode: 'sme-term-conventional',
      variantCode: 'SMALL_LOAN',
      purpose: 'INVENTORY',
      requestedMinorUnits: 25_000_000n,
      tenorMonths: 24,
      graceMonths: 0,
      contributionPerTenThousand: 2_000,
    },
    'upstream',
  );
  expect(r.ok).toBe(true);
}

beforeAll(() => {
  // In memory: the deployment's jurisdiction would otherwise come from a configured test database.
  vi.stubEnv('SANAD_TEST_DATABASE_URL', '');
  process.env['SANAD_JURISDICTION'] = 'AE';
});

describe('business server actions', () => {
  beforeEach(async () => {
    jar.clear();
    resetBusinessStore({ seed: false });
    await handOverTestApplication();
  });

  it('#1 records a figure posted with sourceKind=OCR as OFFICER_ENTRY by the signed-in officer; a different signed-in checker verifies it', async () => {
    OFFICER();
    const proposed = await redirectOf(
      proposeFigureAction,
      form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '900000', sourceKind: 'OCR', sourceRef: 'doc-act' }),
    );
    expect(proposed.searchParams.get('notice')).toBe('FIGURE_PROPOSED');
    const figure = (await getApplication(TENANT, ID))?.figures.find((f) => f.figure.metric === 'NET_PROFIT');
    expect(figure?.figure.sourceKind).toBe('OFFICER_ENTRY');
    expect(figure?.figure.enteredBy).toBe('stf-ae-officer-01');

    CHECKER();
    const verified = await redirectOf(
      verifyFigureAction,
      form({ figureId: figure?.figureId ?? '', sourceKind: 'OCR' }),
    );
    expect(verified.searchParams.get('notice')).toBe('FIGURE_VERIFIED');
    const after = (await getApplication(TENANT, ID))?.figures.find((f) => f.figure.metric === 'NET_PROFIT');
    expect(after?.figure.verification?.verifiedBy).toBe('stf-ae-checker-01');
  });

  it('#1 a read figure (system path) is verified by the signed-in checker', async () => {
    const read = await ingestReadFigures(
      TENANT,
      ID,
      [
        {
          metric: 'ANNUAL_REVENUE',
          periodLabel: 'FY2025',
          minorUnits: 1_000_000n,
          sourceKind: 'OCR',
          sourceRef: 'doc-act',
        },
      ],
      READ_FIGURE_SOURCES.ocr,
    );
    const id = read.ok ? (read.value.figures[0]?.figureId ?? '') : '';
    CHECKER();
    await redirectOf(verifyFigureAction, form({ figureId: id }));
    expect((await getApplication(TENANT, ID))?.figures[0]?.figure.verification?.verifiedBy).toBe('stf-ae-checker-01');
  });

  it('#16 a refusal carries the control and reason codes only, never a message', async () => {
    OFFICER();
    const refused = await redirectOf(
      proposeFigureAction,
      form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: 'not-a-number', sourceRef: 'doc-act' }),
    );
    expect(refused.searchParams.get('control')).toBe('OP-DETERMINACY');
    expect(refused.searchParams.get('reason')).toBe('AMOUNT_MALFORMED');
    expect(refused.searchParams.has('message')).toBe(false);

    CHECKER();
    const domain = await redirectOf(verifyFigureAction, form({ figureId: 'no-such-figure' }));
    expect(domain.searchParams.get('reason')).toBe('FIGURE_NOT_FOUND');
    expect([...domain.searchParams.keys()].sort()).toEqual(['control', 'reason']);
  });

  it('#5 #7 a refusal whose detail would name domain data sends the codes only; an identity number never reaches the URL', async () => {
    OFFICER();
    for (const [action, fields] of [
      [withdrawApplicationAction, { reason: 'Owner 1012345678 changed plans' }],
      [withdrawApplicationAction, { reason: 'Owner 784-1985-1234567-1 changed plans' }],
      [presentDocumentAction, { documentType: 'TRADE_LICENCE', documentRef: 'doc-2087654321' }],
      [
        proposeFigureAction,
        { metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '100', sourceRef: 'stmt-1012345678' },
      ],
    ] as const) {
      const url = await redirectOf(action, form(fields));
      expect(url.searchParams.get('reason')).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
      expect([...url.searchParams.keys()].sort()).toEqual(['control', 'reason']);
      expect(url.href).not.toMatch(/1012345678|2087654321|784-1985/);
    }
    // A domain refusal with context (the status it was in) still sends only its codes.
    const notAllowed = await redirectOf(submitForAssessmentAction, form({}));
    expect([...notAllowed.searchParams.keys()].sort()).toEqual(['control', 'reason']);
    expect((await getApplication(TENANT, ID))?.application.status).toBe('RECEIVED');
  });

  it('#1 an action makes and saves its change as one unit (mutateBusiness): concurrent posts both land', async () => {
    OFFICER();
    const [a, b] = await Promise.all([
      redirectOf(presentDocumentAction, form({ documentType: 'TRADE_LICENCE', documentRef: 'doc-act-a' })),
      redirectOf(presentDocumentAction, form({ documentType: 'MOA_AOA', documentRef: 'doc-act-b' })),
    ]);
    expect(a.searchParams.get('notice')).toBe('DOCUMENT_PRESENTED');
    expect(b.searchParams.get('notice')).toBe('DOCUMENT_PRESENTED');
    expect((await getApplication(TENANT, ID))?.documents.map((d) => d.documentRef).sort()).toEqual([
      'doc-act-a',
      'doc-act-b',
    ]);
  });

  it('the seeded history names distinct fictional people, the finance user distinct from the checker', () => {
    const people = Object.values(SEED_PRINCIPALS);
    expect(new Set(people).size).toBe(people.length);
    expect(SEED_PRINCIPALS.finance).not.toBe(SEED_PRINCIPALS.checker);
  });
});

describe('who may act (SEC-TM08, SEC-TM12, SEC-TM14)', () => {
  beforeEach(async () => {
    jar.clear();
    resetBusinessStore({ seed: false });
    await handOverTestApplication();
  });

  it('refuses an action with no session: the browser is sent to sign in, the locale kept, nothing changed', async () => {
    const url = await redirectOf(
      proposeFigureAction,
      form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '900000', sourceRef: 'doc-act' }),
    );
    expect(url.pathname).toBe('/en/sign-in');
    expect(url.searchParams.get('reason')).toBe('SESSION_REQUIRED');
    expect((await getApplication(TENANT, ID))?.figures ?? []).toHaveLength(0);
  });

  it('refuses a forged or tampered session cookie as no session at all', async () => {
    OFFICER();
    const genuine = jar.get(STAFF_SESSION_COOKIE) ?? '';
    const parts = genuine.split('.');
    const body = parts[2] ?? '';
    // The first character, not the last: a trailing base64url character may carry only padding bits.
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;
    for (const forged of [
      `${parts[0]}.${parts[1]}.${flipped}.${parts[3]}`,
      'v1.AAAA.BBBB.CCCC',
      '{"p":"stf-ae-checker-01","t":"sme-fund-ae","a":"CHECKER"}',
    ]) {
      jar.set(STAFF_SESSION_COOKIE, forged);
      const url = await redirectOf(
        proposeFigureAction,
        form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '1', sourceRef: 'doc-act' }),
      );
      expect(url.pathname).toBe('/en/sign-in');
    }
    expect((await getApplication(TENANT, ID))?.figures ?? []).toHaveLength(0);
  });

  it('refuses an action needing an authority the principal lacks, with a typed reason', async () => {
    OFFICER();
    await redirectOf(
      proposeFigureAction,
      form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '900000', sourceRef: 'doc-act' }),
    );
    const figureId = (await getApplication(TENANT, ID))?.figures[0]?.figureId ?? '';

    // The officer (MAKER) may not verify; a finance user may not run an assessment; a checker may not release money.
    const notChecker = await redirectOf(verifyFigureAction, form({ figureId }));
    expect(notChecker.searchParams.get('reason')).toBe('AUTHORITY_REQUIRED');
    expect(notChecker.searchParams.get('needs')).toBe('CHECKER');
    expect(notChecker.pathname).toBe(`/en/business/${ID}`);
    expect((await getApplication(TENANT, ID))?.figures[0]?.figure.verification).toBeUndefined();

    signIn('stf-ae-finance-01', ['FINANCE']);
    expect((await redirectOf(runAssessmentAction, form({}))).searchParams.get('reason')).toBe('AUTHORITY_REQUIRED');
    expect((await redirectOf(approveStraightThroughAction, form({}))).searchParams.get('reason')).toBe(
      'AUTHORITY_REQUIRED',
    );

    CHECKER();
    const notFinance = await redirectOf(recordDisbursedAction, form({}));
    expect(notFinance.searchParams.get('reason')).toBe('AUTHORITY_REQUIRED');
    expect(notFinance.searchParams.get('needs')).toBe('FINANCE');
    expect(
      (await redirectOf(committeeDecisionAction, form({ approved: 'true', reason: 'fine' }))).searchParams.get(
        'reason',
      ),
    ).toBe('AUTHORITY_REQUIRED');
  });

  it('ignores a tenant form field: the tenant is the principal’s own', async () => {
    OFFICER();
    const url = await redirectOf(
      proposeFigureAction,
      form({ tenant: 'bank-a', metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '900000', sourceRef: 'doc-act' }),
    );
    expect(url.searchParams.get('notice')).toBe('FIGURE_PROPOSED');
    expect((await getApplication(TENANT, ID))?.figures).toHaveLength(1);
  });

  it('refuses a principal whose tenant the deployment does not have active, whatever a form says', async () => {
    signIn('stf-maker-01', ['MAKER'], 'bank-a');
    const url = await redirectOf(
      proposeFigureAction,
      form({ tenant: TENANT, metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '900000', sourceRef: 'doc-act' }),
    );
    expect(url.pathname).toBe('/en/sign-in');
    expect(url.searchParams.get('reason')).toBe('TENANT_NOT_ACTIVE');
    expect((await getApplication(TENANT, ID))?.figures ?? []).toHaveLength(0);
  });

  it('four eyes between people: the same signed-in person cannot key a figure and verify it', async () => {
    signIn('stf-ae-both-01', ['MAKER', 'CHECKER']);
    await redirectOf(
      proposeFigureAction,
      form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '900000', sourceRef: 'doc-act' }),
    );
    const figureId = (await getApplication(TENANT, ID))?.figures[0]?.figureId ?? '';
    const url = await redirectOf(verifyFigureAction, form({ figureId }));
    expect(url.searchParams.get('reason')).toBe('FOUR_EYES_REQUIRED');
    expect((await getApplication(TENANT, ID))?.figures[0]?.figure.verification).toBeUndefined();
  });

  it('four eyes between people: the same signed-in person cannot present a document and validate it', async () => {
    signIn('stf-ae-both-01', ['MAKER', 'CHECKER']);
    await redirectOf(presentDocumentAction, form({ documentType: 'TRADE_LICENCE', documentRef: 'doc-own-1' }));
    const url = await redirectOf(validateDocumentAction, form({ documentRef: 'doc-own-1', decision: 'VALID' }));
    expect(url.searchParams.get('reason')).toBe('FOUR_EYES_REQUIRED');
    expect(
      (await getApplication(TENANT, ID))?.documents.find((d) => d.documentRef === 'doc-own-1')?.validationStatus,
    ).toBe('PENDING');
    // Another person may.
    CHECKER();
    expect(
      (
        await redirectOf(validateDocumentAction, form({ documentRef: 'doc-own-1', decision: 'VALID' }))
      ).searchParams.get('notice'),
    ).toBe('DOCUMENT_VALIDATED');
  });
});

describe('four eyes between people at the decision', () => {
  beforeEach(() => {
    jar.clear();
    resetBusinessStore();
  });

  it('the person who submitted cannot decide the case, in committee or straight through, whatever authorities they hold', async () => {
    const submitted = (await listApplications(TENANT)).find((v) => v.application.status === 'SUBMITTED');
    expect(submitted, 'the illustrative book holds a submitted application').toBeDefined();
    const id = submitted?.application.applicationId ?? '';
    const submitter = submitted?.application.submittedBy ?? '';
    expect(submitter).toBe(SEED_PRINCIPALS.officer);
    const at = (fields: Record<string, string>): FormData =>
      form({ applicationId: id, screen: 'assessment', ...fields });

    // A checker who is not the submitter runs the assessment.
    CHECKER();
    expect((await redirectOf(runAssessmentAction, at({}))).searchParams.get('notice')).toBe('ASSESSED');
    const status = (await getApplication(TENANT, id))?.application.status;

    // The submitting officer, signed in holding every deciding authority, is still refused.
    signIn(submitter, ['MAKER', 'CHECKER', 'SENIOR_CHECKER', 'CREDIT_COMMITTEE']);
    const own =
      status === 'IN_COMMITTEE'
        ? await redirectOf(committeeDecisionAction, at({ approved: 'true', reason: 'my own case' }))
        : await redirectOf(approveStraightThroughAction, at({}));
    expect(own.searchParams.get('reason')).toBe('FOUR_EYES_SELF_APPROVAL');
    expect((await getApplication(TENANT, id))?.application.status).toBe(status);
  });
});

describe('the committee form carries the approved amount and tenor; the server decides', () => {
  beforeEach(() => {
    jar.clear();
    resetBusinessStore();
  });

  it('refuses a malformed or over-request figure by code, records nothing, then records the approved terms', async () => {
    const inCommittee = (await listApplications(TENANT)).find((v) => v.application.status === 'IN_COMMITTEE');
    expect(inCommittee, 'the illustrative book holds an application in committee').toBeDefined();
    const id = inCommittee?.application.applicationId ?? '';
    const requested = inCommittee?.application.requested.minorUnits ?? 0n;
    const at = (fields: Record<string, string>): FormData =>
      form({ applicationId: id, screen: 'assessment', approved: 'true', reason: 'MCC decision', ...fields });
    signIn(SEED_PRINCIPALS.committee, ['CREDIT_COMMITTEE']);

    const malformed = await redirectOf(
      committeeDecisionAction,
      at({ approvedAmount: '1.234', approvedTenorMonths: '' }),
    );
    expect(malformed.searchParams.get('reason')).toBe('APPROVED_AMOUNT_MALFORMED');
    const tenor = await redirectOf(committeeDecisionAction, at({ approvedAmount: '', approvedTenorMonths: '3.5' }));
    expect(tenor.searchParams.get('reason')).toBe('APPROVED_TENOR_MALFORMED');
    // One fils above the request: refused by the domain, and only the codes travel.
    const plusOne = requested + 1n;
    const above = `${(plusOne / 100n).toString()}.${(plusOne % 100n).toString().padStart(2, '0')}`;
    const tooMuch = await redirectOf(committeeDecisionAction, at({ approvedAmount: above, approvedTenorMonths: '' }));
    expect(tooMuch.searchParams.get('control')).toBe('OP-LIMIT');
    expect(tooMuch.searchParams.get('reason')).toBe('APPROVED_AMOUNT_ABOVE_REQUESTED');
    expect([...tooMuch.searchParams.keys()].sort()).toEqual(['control', 'reason']);
    expect((await getApplication(TENANT, id))?.application.status).toBe('IN_COMMITTEE');

    // Empty fields take the server's defaults; the request is kept beside them.
    const done = await redirectOf(committeeDecisionAction, at({ approvedAmount: '', approvedTenorMonths: '' }));
    expect(done.searchParams.get('notice')).toBe('COMMITTEE_APPROVED');
    const after = await getApplication(TENANT, id);
    expect(after?.application.status).toBe('APPROVED');
    expect(after?.approvedTerms?.basis).toBe('COMMITTEE');
    expect(after?.application.requested.minorUnits).toBe(requested);
    expect((after?.approvedTerms?.amount.minorUnits ?? 0n) <= requested).toBe(true);
  });
});
