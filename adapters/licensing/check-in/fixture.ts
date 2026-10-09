/**
 * Licence check-in — fixture transport (ADR 0006 §3).
 *
 * The issuer's check-in server does not exist yet, so this is the only
 * transport: it answers from recorded answers, or as unavailable. It records
 * every request it is sent so a test can assert the payload carries the four
 * permitted fields and nothing else.
 *
 * A fixture transport is not an integration (CLAUDE.md §5): the Licensing
 * module stays BLOCKED until a live transport has checked in against the
 * issuer's server and this directory's README records what was learned.
 */

import type {
  LicenceCheckInOutcome,
  LicenceCheckInPort,
  LicenceCheckInRequest,
} from '../../../core/ports/licence-check-in.ts';

export interface FixtureCheckIn extends LicenceCheckInPort {
  /** Every request sent, in order. */
  readonly sent: readonly LicenceCheckInRequest[];
}

/** Answers each check-in with the next recorded outcome; the last one repeats. */
export function fixtureLicenceCheckIn(answers: readonly (LicenceCheckInOutcome | 'THROWS')[]): FixtureCheckIn {
  const sent: LicenceCheckInRequest[] = [];
  let i = 0;
  return {
    sent,
    checkIn(request) {
      sent.push(request);
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (answer === undefined) return Promise.resolve({ kind: 'UNAVAILABLE', reason: 'NO_FIXTURE' });
      if (answer === 'THROWS') return Promise.reject(new Error('connection refused'));
      return Promise.resolve(answer);
    },
  };
}
