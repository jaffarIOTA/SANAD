/**
 * Handling a check-in answer (ADR 0006 §3), purely.
 *
 * - The payload is built here and holds only the licence id, installation id,
 *   product version and state.
 * - An answer's files are verified with the same verifier — the compiled-in
 *   keyring — as an uploaded licence. A file that does not verify is refused
 *   and reported; it is never installed.
 * - A verified revocation is installed like a licence; `licenceState` then
 *   ends the licence's term on the revocation's `effectiveFrom` and the grace
 *   period starts there. Never an immediate stop.
 * - A failed check-in changes nothing.
 */

import type { LicenceCheckInOutcome, LicenceCheckInRequest } from '../ports/licence-check-in.ts';
import type { LicenceRefusal, SignedDocument } from './licence.ts';
import { parseSignedFile } from './licence.ts';
import type { LicenceState } from './state.ts';
import { type LicenceVerifier, verifyLicence, verifyRevocation } from './verify.ts';

export function checkInRequest(
  state: LicenceState,
  installationId: string,
  productVersion: string,
): LicenceCheckInRequest {
  return {
    licenceId: state.effective?.licenceId ?? null,
    installationId,
    productVersion,
    state: state.status,
  };
}

export interface ToInstall {
  readonly signed: SignedDocument;
  readonly subjectId: string;
}

export type CheckInHandling =
  | { readonly kind: 'NO_CHANGE'; readonly why: 'UNAVAILABLE' | 'NOTHING_NEW' }
  | {
      readonly kind: 'INSTALL';
      readonly install: readonly ToInstall[];
      readonly refused: readonly LicenceRefusal[];
    };

export function handleCheckIn(
  outcome: LicenceCheckInOutcome,
  verifier: LicenceVerifier,
  installationId: string,
  alreadyInstalled: ReadonlySet<string>,
): CheckInHandling {
  if (outcome.kind === 'UNAVAILABLE') return { kind: 'NO_CHANGE', why: 'UNAVAILABLE' };
  const install: ToInstall[] = [];
  const refused: LicenceRefusal[] = [];
  for (const text of outcome.files) {
    const file = parseSignedFile(text);
    if (!file.ok) {
      refused.push(file.error);
      continue;
    }
    if (file.value.kind === 'LICENCE') {
      const v = verifyLicence(file.value, verifier, installationId);
      if (!v.ok) refused.push(v.error);
      else if (!alreadyInstalled.has(v.value.licenceId))
        install.push({ signed: file.value, subjectId: v.value.licenceId });
    } else {
      const v = verifyRevocation(file.value, verifier, installationId);
      if (!v.ok) refused.push(v.error);
      else if (!alreadyInstalled.has(v.value.revocationId))
        install.push({ signed: file.value, subjectId: v.value.revocationId });
    }
  }
  if (install.length === 0 && refused.length === 0) return { kind: 'NO_CHANGE', why: 'NOTHING_NEW' };
  return { kind: 'INSTALL', install, refused };
}
