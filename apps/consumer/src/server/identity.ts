/**
 * Identity for the consumer journey.
 *
 * Production: the national digital identity rail through
 * `core/ports/identity-authentication.ts` (adapters/ksa/nafath). Development:
 * a stand-in that answers as the rail would, so the journey's shape — start,
 * confirm, assertion reference, nothing personal stored — is exercised now
 * and only the adapter changes later. The stand-in is unmistakably labelled.
 */

import { type Result, ok } from '@sanad/core/kernel/result.ts';
import type { IdentityAuthenticationPort } from '@sanad/core/ports/identity-authentication.ts';
import type { RailOutcome } from '@sanad/core/ports/rail.ts';

export function developmentIdentity(nowEpochSeconds: () => bigint): IdentityAuthenticationPort {
  return {
    startAuthentication(
      p,
    ): Promise<Result<RailOutcome<{ readonly transactionRef: string; readonly expiresAtEpochSeconds: bigint }>>> {
      return Promise.resolve(
        ok({
          kind: 'ANSWERED',
          value: { transactionRef: `dev-auth-${p.applicantRef}`, expiresAtEpochSeconds: nowEpochSeconds() + 300n },
        }),
      );
    },
    confirmAuthentication(
      p,
    ): Promise<
      Result<
        RailOutcome<{
          readonly assertionId: string;
          readonly identityRef: string;
          readonly authenticatedAtEpochSeconds: bigint;
        }>
      >
    > {
      const applicantRef = p.transactionRef.replace(/^dev-auth-/, '');
      return Promise.resolve(
        ok({
          kind: 'ANSWERED',
          value: {
            assertionId: `asr-dev-${applicantRef}-${nowEpochSeconds().toString()}`,
            identityRef: `idp-ref-${applicantRef}`,
            authenticatedAtEpochSeconds: nowEpochSeconds(),
          },
        }),
      );
    },
  };
}
