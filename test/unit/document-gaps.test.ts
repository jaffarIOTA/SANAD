/**
 * Document intelligence D4 (core/documents/gaps.ts): what an application still
 * needs from the applicant, from the checklist and the findings — and the
 * words the request carries. Pure.
 */
import { describe, expect, it } from 'vitest';

import type { ItemReport, ItemStatus } from '@sanad/core/documents/checklist.ts';
import { type DocumentGap, type FindingChecks, gapMessage, gapSetKey, gapsOf } from '@sanad/core/documents/gaps.ts';

const item = (documentType: string, status: ItemStatus, required = true): ItemReport => ({
  item: { documentType, titleEn: `${documentType} doc`, titleAr: `مستند ${documentType}`, required },
  status,
});
const checks = (...c: [string, 'PASS' | 'FAIL' | 'UNREADABLE'][]): FindingChecks =>
  c.map(([check, outcome]) => ({ check, outcome }));

describe('gaps from the checklist', () => {
  it('missing, expired and refused required items are gaps; optional and present ones are not', () => {
    const gaps = gapsOf(
      [
        item('A', 'MISSING'),
        item('B', 'EXPIRED'),
        item('C', 'INVALID'),
        item('D', 'PRESENT'),
        item('E', 'MISSING', false),
        item('F', 'INVALID', false),
      ],
      () => undefined,
    );
    expect(gaps.map((g) => [g.documentType, g.kind])).toEqual([
      ['A', 'MISSING'],
      ['B', 'EXPIRED'],
      ['C', 'REJECTED'],
    ]);
  });
});

describe('gaps from the findings, on a document awaiting the checker', () => {
  const pending = (c: FindingChecks) => gapsOf([item('CR', 'PENDING')], () => c);

  it('the wrong document, then the issuer not confirming it, then any failed check — one gap per item', () => {
    expect(pending(checks(['TYPE_MATCHES_DECLARED', 'FAIL'], ['AUTHENTIC', 'FAIL']))[0]?.kind).toBe('WRONG_TYPE');
    expect(pending(checks(['TYPE_MATCHES_DECLARED', 'PASS'], ['AUTHENTIC', 'FAIL']))[0]?.kind).toBe('NOT_AUTHENTIC');
    expect(pending(checks(['NOT_EXPIRED', 'FAIL'], ['REGISTRATION_MATCHES', 'FAIL']))).toEqual([
      expect.objectContaining({ kind: 'CHECK_FAILED', failedChecks: ['NOT_EXPIRED', 'REGISTRATION_MATCHES'] }),
    ]);
  });

  it('a check that could not be made is never a gap: the applicant is not asked to fix what was not read', () => {
    expect(pending(checks(['TYPE_MATCHES_DECLARED', 'UNREADABLE'], ['AUTHENTIC', 'UNREADABLE']))).toEqual([]);
    expect(gapsOf([item('CR', 'PENDING')], () => undefined)).toEqual([]);
  });

  it('a document the checker accepted is never a gap, whatever its checks said', () => {
    expect(gapsOf([item('CR', 'PRESENT')], () => checks(['NOT_EXPIRED', 'FAIL']))).toEqual([]);
  });
});

describe('the request', () => {
  const g = (documentType: string, kind: DocumentGap['kind'], failedChecks?: string[]): DocumentGap => ({
    documentType,
    titleEn: 'Commercial registration',
    titleAr: 'السجل التجاري',
    kind,
    ...(failedChecks === undefined ? {} : { failedChecks }),
  });

  it('one key per gap set, whatever the order', () => {
    expect(gapSetKey([g('A', 'MISSING'), g('B', 'EXPIRED')])).toBe(gapSetKey([g('B', 'EXPIRED'), g('A', 'MISSING')]));
    expect(gapSetKey([g('A', 'MISSING')])).not.toBe(gapSetKey([g('A', 'EXPIRED')]));
    expect(gapSetKey([g('A', 'CHECK_FAILED', ['X', 'Y'])])).toBe(gapSetKey([g('A', 'CHECK_FAILED', ['Y', 'X'])]));
  });

  it('says what to do in both languages for every kind of gap', () => {
    for (const kind of ['MISSING', 'EXPIRED', 'REJECTED', 'WRONG_TYPE', 'NOT_AUTHENTIC', 'CHECK_FAILED'] as const) {
      const m = gapMessage(g('CR', kind, kind === 'CHECK_FAILED' ? ['PERIOD_COVERS'] : undefined));
      expect(m.en).toContain('Commercial registration');
      expect(m.ar).toContain('السجل التجاري');
      expect(m.en).toMatch(/send/i);
      expect(m.ar).toContain('إرسال');
    }
    expect(gapMessage(g('CR', 'CHECK_FAILED', ['NOT_EXPIRED', 'ISSUED_WITHIN'])).en).toContain(
      'has expired or is about to expire, and is older than we can accept',
    );
  });
});
