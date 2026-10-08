/**
 * The business server actions, called as a browser's form post would call
 * them (Next's redirect and revalidation stood in for).
 *
 *  #1  a form that says sourceKind=OCR still records OFFICER_ENTRY by the
 *      acting officer, and the verifier is chosen from the stored figure,
 *      never from a hidden field
 *  #16 a refusal redirects with the control and reason codes only — no free
 *      text in the URL for a screen to echo
 *  #13 disbursement is released by the finance principal
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { url }); },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

import { BUSINESS_ROLES, READ_FIGURE_SOURCES, getApplication, handOver, ingestReadFigures, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import { proposeFigureAction, verifyFigureAction } from '../../apps/ops/src/server/business-actions.ts';

const TENANT = 'sme-fund-ae' as const;
const ID = 'FR-00009101';

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

describe('business server actions', () => {
  beforeAll(() => { process.env['SANAD_JURISDICTION'] = 'AE'; });
  beforeEach(async () => {
    resetBusinessStore({ seed: false });
    const r = await handOver(TENANT, {
      applicationId: ID, upstreamRef: 'upstream-actions-9101',
      applicant: { businessNameEn: 'Actions Test LLC', registrationRef: 'TL-ACT-9101', sector: 'TRADING', yearsInOperation: 4, owners: [{ displayName: 'Actions Owner Example', ref: 'owner-act-9101' }], upstreamVerificationRefs: ['uaepass:assert-act'] },
      productCode: 'sme-term-conventional', variantCode: 'SMALL_LOAN', purpose: 'INVENTORY', requestedMinorUnits: 25_000_000n, tenorMonths: 24, graceMonths: 0, contributionPerTenThousand: 2_000,
    }, 'upstream');
    expect(r.ok).toBe(true);
  });

  it('#1 records a figure posted with sourceKind=OCR as OFFICER_ENTRY by the officer; a verify posted as OCR goes to the checker', async () => {
    const proposed = await redirectOf(proposeFigureAction, form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: '900000', sourceKind: 'OCR', sourceRef: 'doc-act' }));
    expect(proposed.searchParams.get('notice')).toBe('FIGURE_PROPOSED');
    const figure = (await getApplication(TENANT, ID))?.figures.find((f) => f.figure.metric === 'NET_PROFIT');
    expect(figure?.figure.sourceKind).toBe('OFFICER_ENTRY');
    expect(figure?.figure.enteredBy).toBe(BUSINESS_ROLES.officer);

    // The hidden field claims OCR, which used to route verification to the officer — the person who keyed it.
    const verified = await redirectOf(verifyFigureAction, form({ figureId: figure?.figureId ?? '', sourceKind: 'OCR' }));
    expect(verified.searchParams.get('notice')).toBe('FIGURE_VERIFIED');
    const after = (await getApplication(TENANT, ID))?.figures.find((f) => f.figure.metric === 'NET_PROFIT');
    expect(after?.figure.verification?.verifiedBy).toBe(BUSINESS_ROLES.checker);
  });

  it('#1 a read figure (system path) is verified by the officer', async () => {
    const read = await ingestReadFigures(TENANT, ID, [{ metric: 'ANNUAL_REVENUE', periodLabel: 'FY2025', minorUnits: 1_000_000n, sourceKind: 'OCR', sourceRef: 'doc-act' }], READ_FIGURE_SOURCES.ocr);
    const id = read.ok ? read.value.figures[0]?.figureId ?? '' : '';
    await redirectOf(verifyFigureAction, form({ figureId: id }));
    expect((await getApplication(TENANT, ID))?.figures[0]?.figure.verification?.verifiedBy).toBe(BUSINESS_ROLES.officer);
  });

  it('#16 a refusal carries the control and reason codes only, never a message', async () => {
    const refused = await redirectOf(proposeFigureAction, form({ metric: 'NET_PROFIT', periodLabel: 'FY2025', amount: 'not-a-number', sourceRef: 'doc-act' }));
    expect(refused.searchParams.get('control')).toBe('OP-DETERMINACY');
    expect(refused.searchParams.get('reason')).toBe('AMOUNT_MALFORMED');
    expect(refused.searchParams.has('message')).toBe(false);

    const domain = await redirectOf(verifyFigureAction, form({ figureId: 'no-such-figure' }));
    expect(domain.searchParams.get('reason')).toBe('FIGURE_NOT_FOUND');
    expect([...domain.searchParams.keys()].sort()).toEqual(['control', 'reason']);
  });

  it('#13 the finance principal is a distinct role', () => {
    const roles = Object.values(BUSINESS_ROLES);
    expect(new Set(roles).size).toBe(roles.length);
    expect(BUSINESS_ROLES.finance).not.toBe(BUSINESS_ROLES.checker);
  });
});
