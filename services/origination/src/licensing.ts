/**
 * The installation's licence, for every app (ADR 0006).
 *
 * Every app asks here, and only here, whether new business may start:
 * `newBusinessPermitted()` reads the installed history, raises the clock
 * high-water mark, computes the state with `licenceState` and hands it to the
 * one gate, `assertNewBusinessPermitted` (core/licensing/gate.ts), together
 * with the deployment's jurisdiction and active tenant count (ADR 0005).
 *
 * With a database: migration 0017, through `licence-postgres.ts`. Without one
 * (development, tests): an in-memory store for this process. The verifier is
 * the compiled-in keyring; `createVerifier` refuses any other keyring under
 * production, and `configureLicensingForTests` refuses to run there at all.
 *
 * Called at new-business entry points only. Servicing, collections,
 * repayments, bureau reporting, the outbox, audit, exports, sign-in and
 * licence installation never call it.
 */

import { randomUUID } from 'node:crypto';

import type { Rejection, Result } from '../../../core/kernel/result.ts';
import { err, ok } from '../../../core/kernel/result.ts';
import { checkInRequest, handleCheckIn } from '../../../core/licensing/check-in.ts';
import {
  type LicenceNotActive,
  type NewBusinessPermitted,
  assertNewBusinessPermitted,
  licenceRejection,
} from '../../../core/licensing/gate.ts';
import type { LicenceRefusal, SignedDocument } from '../../../core/licensing/licence.ts';
import {
  type InstalledEntry,
  type LicenceProposal,
  type LicenceRepository,
  type LicenceStoreRefusal,
  inMemoryLicenceRepository,
} from '../../../core/licensing/repository.ts';
import { type LicenceRequestFile, licenceRequestFile } from '../../../core/licensing/request-file.ts';
import { type LicenceState, licenceState } from '../../../core/licensing/state.ts';
import {
  type LicenceVerifier,
  createVerifier,
  verifyLicence,
  verifyLicenceFile,
  verifyRevocation,
} from '../../../core/licensing/verify.ts';
import type { LicenceCheckInPort } from '../../../core/ports/licence-check-in.ts';

import { databaseUrlFromEnvironment, sharedPool } from './credentials.ts';
import { deploymentJurisdiction } from './jurisdiction.ts';
import { postgresLicenceRepository } from './licence-postgres.ts';

export interface LicensingRuntime {
  readonly repository: LicenceRepository;
  readonly verifier: LicenceVerifier;
  /** Epoch seconds. The wall clock outside tests; core never reads one. */
  readonly clock: () => bigint;
}

interface State {
  override?: LicensingRuntime;
  fallback?: LicensingRuntime;
  url?: string | undefined;
}
const state: State = ((globalThis as { __sanadLicensing?: State }).__sanadLicensing ??= {});

const wallClock = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const production = (): boolean => process.env['NODE_ENV'] === 'production';

function defaultRuntime(): LicensingRuntime {
  const url = databaseUrlFromEnvironment();
  if (state.fallback !== undefined && state.url === url) return state.fallback;
  const verifier = createVerifier({ nodeEnv: process.env['NODE_ENV'] });
  if (!verifier.ok) throw new Error(verifier.error.detail);
  state.fallback = {
    repository:
      url === undefined ? inMemoryLicenceRepository({ clock: wallClock }) : postgresLicenceRepository(sharedPool(url)),
    verifier: verifier.value,
    clock: wallClock,
  };
  state.url = url;
  return state.fallback;
}

export function licensingRuntime(): LicensingRuntime {
  return state.override ?? defaultRuntime();
}

/**
 * Tests only: substitute the store, the verifier (built by `createVerifier`,
 * so its keyring is already subject to the production refusal) and the
 * clock. Refused outright under production — a production installation's
 * licence is the one in its database, checked against the compiled-in keys.
 */
export function configureLicensingForTests(runtime: LicensingRuntime | undefined): void {
  if (production()) throw new Error('the licensing runtime is not configurable in production');
  if (runtime === undefined) delete state.override;
  else state.override = runtime;
}

export function productVersion(): string {
  return process.env['SANAD_PRODUCT_VERSION']?.trim() || '0.0.0-development';
}

export interface CurrentLicence {
  readonly installationId: string;
  readonly state: LicenceState;
  readonly history: readonly InstalledEntry[];
}

/** The state now, raising the clock high-water mark as it reads it. */
export async function currentLicence(): Promise<CurrentLicence> {
  const rt = licensingRuntime();
  const now = rt.clock();
  const before = await rt.repository.observeClock(now);
  const installation = await rt.repository.installation();
  const history = await rt.repository.history();
  return {
    installationId: installation.installationId,
    history,
    state: licenceState(history, { installationId: installation.installationId, verifier: rt.verifier }, now, before),
  };
}

export interface NewBusinessAct {
  /** The product module code the act is for. */
  readonly productCode: string;
  /** Booking a facility: when the customer accepted its offer. */
  readonly booking?: { readonly offerAcceptedAtEpochSeconds: bigint };
}

/** Ask the one gate. The jurisdiction and active tenant count come from the deployment, never from a request. */
export async function newBusinessPermitted(
  act: NewBusinessAct,
): Promise<Result<NewBusinessPermitted, LicenceNotActive>> {
  const [{ state: s }, deployment] = await Promise.all([currentLicence(), deploymentJurisdiction()]);
  return assertNewBusinessPermitted({
    state: s,
    productCode: act.productCode,
    jurisdiction: deployment.code,
    activeTenantCount: deployment.activeTenants.length,
    ...(act.booking === undefined ? {} : { booking: act.booking }),
  });
}

/** The gate's refusal as a control-coded rejection (OP-LICENCE / LICENCE_NOT_ACTIVE), or undefined when permitted. */
export async function newBusinessRefusal(act: NewBusinessAct): Promise<Rejection | undefined> {
  const r = await newBusinessPermitted(act);
  return r.ok ? undefined : licenceRejection(r.error);
}

// -- Installing a licence (Admin → Licence, four eyes) --------------------------------------------

export type InstallRefusal =
  | { readonly kind: 'LICENCE'; readonly refusal: LicenceRefusal }
  | { readonly kind: 'STORE'; readonly refusal: LicenceStoreRefusal };

/** A maker proposes a licence file. It is verified before it is stored; a second administrator decides. */
export async function proposeLicenceInstall(p: {
  readonly fileText: string;
  readonly proposedBy: string;
}): Promise<Result<string, InstallRefusal>> {
  const rt = licensingRuntime();
  const { installationId } = await rt.repository.installation();
  const verified = verifyLicenceFile(p.fileText, rt.verifier, installationId);
  if (!verified.ok) return err({ kind: 'LICENCE', refusal: verified.error });
  const proposed = await rt.repository.propose({
    signed: verified.value.signed,
    subjectId: verified.value.licence.licenceId,
    proposedBy: p.proposedBy,
    correlationId: randomUUID(),
  });
  return proposed.ok ? ok(proposed.value) : err({ kind: 'STORE', refusal: proposed.error });
}

/** The checker approves (installing it, re-verified now) or rejects. Never the proposer. */
export async function decideLicenceInstall(p: {
  readonly proposalId: string;
  readonly approve: boolean;
  readonly decidedBy: string;
  readonly reason?: string;
}): Promise<Result<true, InstallRefusal>> {
  const rt = licensingRuntime();
  if (p.approve) {
    const proposal = (await rt.repository.proposals()).find((x) => x.proposalId === p.proposalId);
    if (proposal !== undefined) {
      const { installationId } = await rt.repository.installation();
      const doc: SignedDocument = { kind: proposal.kind, document: proposal.document, signature: proposal.signature };
      const v =
        doc.kind === 'LICENCE'
          ? verifyLicence(doc, rt.verifier, installationId)
          : verifyRevocation(doc, rt.verifier, installationId);
      if (!v.ok) return err({ kind: 'LICENCE', refusal: v.error });
    }
  }
  const decided = await rt.repository.decide({
    proposalId: p.proposalId,
    approve: p.approve,
    decidedBy: p.decidedBy,
    ...(p.reason === undefined ? {} : { reason: p.reason }),
    correlationId: randomUUID(),
  });
  return decided.ok ? ok(true) : err({ kind: 'STORE', refusal: decided.error });
}

export async function licenceProposals(): Promise<readonly LicenceProposal[]> {
  return licensingRuntime().repository.proposals();
}

/** The request file an institution sends the issuer (ADR 0006 §2). No customer data. */
export async function currentLicenceRequestFile(): Promise<LicenceRequestFile> {
  const [current, deployment] = await Promise.all([currentLicence(), deploymentJurisdiction()]);
  return licenceRequestFile({
    installationId: current.installationId,
    state: current.state,
    jurisdiction: deployment.code,
    productVersion: productVersion(),
    nowEpochSeconds: licensingRuntime().clock(),
  });
}

// -- Online check-in (ADR 0006 §3) -------------------------------------------------------------------

export type CheckInResult =
  | { readonly kind: 'NO_CHANGE'; readonly why: 'UNAVAILABLE' | 'NOTHING_NEW' }
  | { readonly kind: 'INSTALLED'; readonly installed: number; readonly refused: number };

/**
 * One check-in. Sends only the licence id, installation id, product version
 * and state; installs what comes back only once verified against the same
 * keyring as an uploaded file. A failed check-in changes nothing.
 */
export async function runLicenceCheckIn(port: LicenceCheckInPort): Promise<CheckInResult> {
  const rt = licensingRuntime();
  const current = await currentLicence();
  let outcome;
  try {
    outcome = await port.checkIn(checkInRequest(current.state, current.installationId, productVersion()));
  } catch {
    outcome = { kind: 'UNAVAILABLE' as const, reason: 'TRANSPORT_FAILED' };
  }
  const handled = handleCheckIn(
    outcome,
    rt.verifier,
    current.installationId,
    new Set(current.history.map((e) => e.subjectId)),
  );
  if (handled.kind === 'NO_CHANGE') return handled;
  for (const item of handled.install) {
    await rt.repository.recordFromCheckIn({
      signed: item.signed,
      subjectId: item.subjectId,
      correlationId: randomUUID(),
    });
  }
  return { kind: 'INSTALLED', installed: handled.install.length, refused: handled.refused.length };
}
