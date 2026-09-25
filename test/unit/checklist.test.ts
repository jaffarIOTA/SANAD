import { describe, expect, it } from 'vitest';
import { loadDocumentChecklist, TENANT_CODES } from '@sanad/config/loader.ts';
import { blockingItems, checklistReport, isChecklistComplete, parseDocumentChecklist } from '../../core/documents/checklist.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { tsaInstant } from '../../core/time/tsa.ts';

const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const list = expectOk(loadDocumentChecklist('bank-a', 'prg-0001'));
const doc = (documentType: string, s: number, validationStatus: 'VALID' | 'INVALID' | 'PENDING' = 'VALID') => ({ documentType, capturedAt: at(s), validationStatus });

describe('checklists are per tenant and programme, parsed strictly', () => {
  it.each(TENANT_CODES)('%s has a checklist for prg-0001', (t) => { expect(loadDocumentChecklist(t, 'prg-0001').ok).toBe(true); });
  it('the second client requires fewer papers — configuration, not code', () => { expect(expectOk(loadDocumentChecklist('fintech-b', 'prg-0001')).items.filter((i) => i.required).length).toBeLessThan(list.items.filter((i) => i.required).length); });
  it('refuses unknown sections and duplicate document types', () => {
    expect(parseDocumentChecklist({ tenantId: 't', programmeId: 'p', version: '1', items: [], extra: 1 }).ok).toBe(false);
    expect(parseDocumentChecklist({ tenantId: 't', programmeId: 'p', version: '1', items: [{ documentType: 'A', titleEn: 'a', titleAr: 'أ', required: true }, { documentType: 'A', titleEn: 'a', titleAr: 'أ', required: false }] }).ok).toBe(false);
  });
});

describe('status is a pure function of evidence and an observed instant', () => {
  it('reports missing, present, pending, invalid', () => {
    const r = checklistReport(list, [doc('CLEARED_INVOICE', 100), doc('COMMERCIAL_REGISTRATION', 100, 'PENDING'), doc('SIGNATORY_AUTHORITY', 100, 'INVALID')], at(200));
    const by = Object.fromEntries(r.map((x) => [x.item.documentType, x.status]));
    expect(by['CLEARED_INVOICE']).toBe('PRESENT'); expect(by['COMMERCIAL_REGISTRATION']).toBe('PENDING'); expect(by['SIGNATORY_AUTHORITY']).toBe('INVALID'); expect(by['BANK_STATEMENT_6M']).toBe('MISSING');
    expect(isChecklistComplete(r)).toBe(false);
  });
  it('a document expires after its validity, and the newest copy is the one that counts', () => {
    const early = checklistReport(list, [doc('BANK_STATEMENT_6M', 0)], at(7_776_000 - 1));
    const late = checklistReport(list, [doc('BANK_STATEMENT_6M', 0)], at(7_776_000));
    const renewed = checklistReport(list, [doc('BANK_STATEMENT_6M', 0), doc('BANK_STATEMENT_6M', 7_000_000)], at(7_776_000));
    const s = (r: ReturnType<typeof checklistReport>) => r.find((x) => x.item.documentType === 'BANK_STATEMENT_6M')?.status;
    expect(s(early)).toBe('PRESENT'); expect(s(late)).toBe('EXPIRED'); expect(s(renewed)).toBe('PRESENT');
  });
  it('optional items never block completeness', () => {
    const all = list.items.filter((i) => i.required).map((i) => doc(i.documentType, 100));
    const r = checklistReport(list, all, at(200));
    expect(isChecklistComplete(r)).toBe(true); expect(blockingItems(r)).toHaveLength(0);
    expect(r.find((x) => x.item.documentType === 'ZAKAT_CERTIFICATE')?.status).toBe('MISSING');
  });
});
