/**
 * Document intelligence D5 (core/documents/metrics.ts): the throughput view's
 * figures, measured against what the checkers decided. Pure.
 */
import { describe, expect, it } from 'vitest';

import { type MeasuredDocument, type MeasuredSubject, documentMetrics } from '@sanad/core/documents/metrics.ts';

type C = 'PASS' | 'FAIL' | 'UNREADABLE';
const doc = (
  documentType: string,
  decision: MeasuredDocument['decision'],
  checks?: [string, C][],
  presented = 1_000n,
  decided?: bigint,
): MeasuredDocument => ({
  documentType,
  presentedAtEpochSeconds: presented,
  decision,
  ...(decided === undefined ? {} : { decidedAtEpochSeconds: decided }),
  ...(checks === undefined ? {} : { checks: checks.map(([check, outcome]) => ({ check, outcome })) }),
});
const subject = (documents: MeasuredDocument[], requiredTypes: string[] = [], requests = 0): MeasuredSubject => ({
  documents,
  requiredTypes,
  requests,
});

describe('naming the document at the first attempt', () => {
  it('counts the first document of each type against the checker; a re-presentation is not a first attempt', () => {
    const m = documentMetrics([
      subject([
        doc('CR', 'VALID', [['TYPE_MATCHES_DECLARED', 'PASS']]),
        doc('ID', 'VALID', [['TYPE_MATCHES_DECLARED', 'FAIL']]),
        doc('ST', 'INVALID', [['TYPE_MATCHES_DECLARED', 'FAIL']]),
        doc('ST', 'VALID', [['TYPE_MATCHES_DECLARED', 'PASS']]),
        doc('ZK', 'VALID', [['TYPE_MATCHES_DECLARED', 'UNREADABLE']]),
        doc('AD', 'PENDING', [['TYPE_MATCHES_DECLARED', 'PASS']]),
        doc('AA', 'VALID'),
      ]),
    ]);
    expect(m.firstAttempt).toEqual({ namedRight: 1, namedWrong: 1, flaggedAndRefused: 1, notNamed: 1 });
    expect(m.documents).toBe(7);
    expect(m.read).toBe(6);
  });
});

describe('the checker against the findings', () => {
  it('agrees when it accepts with nothing failing or refuses with something failing; overrides are counted by check', () => {
    const m = documentMetrics([
      subject([
        doc('A', 'VALID', [['NOT_EXPIRED', 'PASS']]),
        doc('B', 'INVALID', [['NOT_EXPIRED', 'FAIL']]),
        doc('C', 'VALID', [
          ['NOT_EXPIRED', 'FAIL'],
          ['AUTHENTIC', 'FAIL'],
        ]),
        doc('D', 'INVALID', [['NOT_EXPIRED', 'PASS']]),
        doc('E', 'VALID', [['NOT_EXPIRED', 'UNREADABLE']]),
        doc('F', 'PENDING', [['NOT_EXPIRED', 'FAIL']]),
      ]),
    ]);
    expect(m.checker).toEqual({
      decided: 4,
      agreed: 2,
      acceptedDespiteFailure: 1,
      acceptedDespiteFailureByCheck: { NOT_EXPIRED: 1, AUTHENTIC: 1 },
      refusedWithNothingFailing: 1,
    });
    expect(m.checks['NOT_EXPIRED']).toEqual({ pass: 2, fail: 3, unreadable: 1 });
  });
});

describe('touchpoints and time to a complete pack', () => {
  it('counts presentations and requests per application with any document', () => {
    const m = documentMetrics([
      subject([doc('A', 'PENDING')], [], 2),
      subject([doc('A', 'PENDING'), doc('B', 'PENDING')]),
      subject([doc('A', 'PENDING'), doc('A', 'PENDING'), doc('B', 'PENDING'), doc('C', 'PENDING')], [], 1),
      subject([], [], 3),
    ]);
    expect(m.touchpoints).toEqual({ applications: 3, median: 3, max: 5 });
  });

  it('a pack is complete when every required type’s latest document is accepted, at the last acceptance', () => {
    const complete = subject(
      [doc('A', 'VALID', undefined, 1_000n, 4_600n), doc('B', 'VALID', undefined, 2_000n, 1_000n + 86_400n * 3n)],
      ['A', 'B'],
    );
    const refusedLatest = subject(
      [doc('A', 'VALID', undefined, 1_000n, 2_000n), doc('A', 'INVALID', undefined, 3_000n, 4_000n)],
      ['A'],
    );
    const pending = subject([doc('A', 'PENDING')], ['A']);
    const m = documentMetrics([complete, refusedLatest, pending]);
    expect(m.timeToComplete).toEqual({ complete: 1, medianSeconds: 86_400n * 3n, p90Seconds: 86_400n * 3n });
  });

  it('nothing measured is nothing claimed', () => {
    const m = documentMetrics([]);
    expect(m.timeToComplete).toEqual({ complete: 0 });
    expect(m.touchpoints).toEqual({ applications: 0, median: 0, max: 0 });
  });
});
