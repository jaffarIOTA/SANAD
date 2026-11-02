/**
 * Signing the offer through the national digital identity's signing intent
 * (UAE M5a): open the intent on the letter version that was sent, bound to
 * its SHA-256; confirm it once the signatory has signed.
 *
 * It sits between the identity rail and the application service, as
 * business-rails.ts does for the bureau. The rail is the fenced one: the
 * demonstration transport, labelled Fixture, only where a synthetic
 * demonstration is permitted; UNAVAILABLE everywhere else until UAE Pass has
 * made a verified sandbox call (adapters/uae/uae-pass/README.md). A refusal or
 * an outage signs nothing (CLAUDE.md §5).
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { inMemoryAssertionReplayGuard } from '@sanad/core/ports/assertion-replay.ts';
import type { IdentityAuthenticationPort } from '@sanad/core/ports/identity-authentication.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import { DemonstrationTransport } from '../../../../adapters/uae/demonstration/transport.ts';
import { UaePassAdapter } from '../../../../adapters/uae/uae-pass/adapter.ts';
import { KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { NafathAdapter } from '../../../../adapters/ksa/nafath/adapter.ts';
import {
  type BusinessApplicationView,
  getApplication,
  recordSignatureConfirmed,
  recordSigningEnded,
  recordSigningStarted,
} from './business.ts';
import { intakeConsentLedger } from './intake.ts';
import { DemonstrationCredentials, demonstrationConfig, tenantJurisdiction } from './intake-rails.ts';
import { persistencePool } from './persistence.ts';
import { developmentAttestation } from './store.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const nowSeconds = (): number => Number(developmentAttestation().epochSeconds);

/** One replay guard per process for the demonstration: an assertion is consumed once. */
const REPLAY_KEY = Symbol.for('sanad.ops.signingAssertionReplay');
const replayGuard = () => {
  const g = globalThis as { [REPLAY_KEY]?: ReturnType<typeof inMemoryAssertionReplayGuard> };
  g[REPLAY_KEY] ??= inMemoryAssertionReplayGuard();
  return g[REPLAY_KEY];
};

async function signingRail(
  tenant: TenantCode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<
  | { readonly port: IdentityAuthenticationPort; readonly source: 'LIVE' | 'FIXTURE'; readonly rail: 'UAE_PASS' | 'NAFATH' }
  | undefined
> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(env), env))) return undefined;
  const config = {
    ...demonstrationConfig(tenant, 'IDENTITY_AUTHENTICATION', await intakeConsentLedger(tenant), nowSeconds),
    assertionReplay: replayGuard(),
  };
  // The jurisdiction's national identity: Nafath in Saudi Arabia, UAE Pass in the UAE.
  if (tenantJurisdiction(tenant) === 'SA')
    return {
      port: new NafathAdapter(config, new DemonstrationCredentials(), new KsaDemonstrationTransport(nowSeconds)),
      source: 'FIXTURE',
      rail: 'NAFATH',
    };
  return {
    port: new UaePassAdapter(config, new DemonstrationCredentials(), new DemonstrationTransport(nowSeconds)),
    source: 'FIXTURE',
    rail: 'UAE_PASS',
  };
}

/** Open the signing intent for the signatory on the letter version that was sent. */
export async function startSigning(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const view = await getApplication(tenant, applicationId);
  if (view === undefined) return fail('BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  const letterVersion = view.application.offer?.letterVersion;
  if (view.application.status !== 'OFFER_SENT' || letterVersion === undefined)
    return fail('TRANSITION_NOT_ALLOWED', 'Signing opens once the offer has been sent', {
      status: view.application.status,
    });
  const rail = await signingRail(tenant);
  if (rail === undefined)
    return fail('RAIL_UNAVAILABLE', 'The identity service is not connected here; nothing was opened', {
      rail: 'UAE_PASS',
    });
  const r = await rail.port.startAuthentication({
    tenantId: tenant,
    applicantRef: view.contact.partyRef,
    purpose: 'SIGNATURE_INTENT',
    documentHash: letterVersion,
    correlationId: applicationId,
  });
  if (!r.ok) return r;
  if (r.value.kind === 'UNAVAILABLE')
    return fail('RAIL_UNAVAILABLE', 'The identity service did not answer; nothing was opened', { rail: 'IDENTITY_AUTHENTICATION' });
  if (r.value.kind === 'REFUSED')
    return fail('SIGNATURE_REFUSED', 'The identity service refused to open the signing', { code: r.value.code });
  return recordSigningStarted(tenant, applicationId, { ...r.value.value, letterVersion, source: rail.source }, actor);
}

/** Ask the identity service whether the signatory has signed; record the signature if so. */
export async function confirmSigning(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const view = await getApplication(tenant, applicationId);
  if (view === undefined) return fail('BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  const signing = view.closing.signing;
  if (signing === undefined) return fail('SIGNING_NOT_STARTED', 'Open the signing first');
  const rail = await signingRail(tenant);
  if (rail === undefined)
    return fail('RAIL_UNAVAILABLE', 'The identity service is not connected here; nothing was confirmed', {
      rail: 'UAE_PASS',
    });
  const r = await rail.port.confirmAuthentication({
    tenantId: tenant,
    transactionRef: signing.transactionRef,
    correlationId: applicationId,
  });
  if (!r.ok) return r;
  if (r.value.kind === 'UNAVAILABLE')
    return fail('RAIL_UNAVAILABLE', 'The identity service did not answer; nothing was confirmed', { rail: 'IDENTITY_AUTHENTICATION' });
  if (r.value.kind === 'REFUSED') {
    // UAE Pass says STATUS_PENDING, Nafath STATUS_WAITING: the signatory has not answered yet.
    if (r.value.code === 'STATUS_PENDING' || r.value.code === 'STATUS_WAITING')
      return fail('SIGNATURE_PENDING', 'The signatory has not signed yet');
    // Refused, cancelled, expired or at too low an assurance: the intent is closed so a new one can open.
    await recordSigningEnded(tenant, applicationId, r.value.code, actor);
    return fail('SIGNATURE_REFUSED', 'The identity service did not confirm a signature', { code: r.value.code });
  }
  return recordSignatureConfirmed(
    tenant,
    applicationId,
    { assertionId: r.value.value.assertionId, identityRef: r.value.value.identityRef, source: rail.source },
    actor,
    rail.rail === 'NAFATH' ? 'nafath' : 'uaepass',
  );
}
