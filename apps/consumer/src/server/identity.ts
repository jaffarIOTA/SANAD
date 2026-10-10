/**
 * Identity for the consumer journey.
 *
 * Production: the national digital identity rail through
 * `core/ports/identity-authentication.ts` (adapters/ksa/nafath). Development:
 * a stand-in that answers as the rail would, so the journey's shape — start,
 * confirm, assertion reference, nothing personal stored — is exercised now
 * and only the adapter changes later. The stand-in is unmistakably labelled.
 *
 * The stand-in authenticates whoever types a reference, so it is reachable
 * only where impersonation cannot touch a real person (SR-005): development,
 * or a hosted environment that declares synthetic data and whose database
 * confirms it. Anywhere else there is no identity provider until the live
 * rail is wired, and sign-in is refused.
 */

import { type Result, ok } from '@sanad/core/kernel/result.ts';
import type { IdentityAuthenticationPort } from '@sanad/core/ports/identity-authentication.ts';
import type { RailOutcome } from '@sanad/core/ports/rail.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import { persistencePool } from './persistence.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** The identity provider this deployment may use, or undefined when it has none. */
export async function consumerIdentity(
  nowEpochSeconds: () => bigint,
  env: Env = process.env,
): Promise<IdentityAuthenticationPort | undefined> {
  return (await demonstrationSignInPermitted(env)) ? developmentIdentity(nowEpochSeconds) : undefined;
}

/** Whether the demonstration sign-in (a typed applicant reference) may be offered here. */
export const demonstrationSignInPermitted = (env: Env = process.env): Promise<boolean> =>
  syntheticDemonstrationPermitted(persistencePool(env), env);

function developmentIdentity(nowEpochSeconds: () => bigint): IdentityAuthenticationPort {
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
    confirmAuthentication(p): Promise<
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
            // The stand-in vouches for whoever was typed, so the confirmed identity is that reference.
            identityRef: applicantRef,
            authenticatedAtEpochSeconds: nowEpochSeconds(),
          },
        }),
      );
    },
  };
}
