/**
 * UAE Pass — identity authentication adapter (ADR 0005).
 *
 * Implements the IdentityAuthenticationPort: login, step-up, and the signing
 * intent that anchors an electronic signature. The national digital identity
 * answers with the person's Emirates ID and profile; only an opaque subject
 * reference and the assertion cross the port.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { IdentityAuthenticationPort } from '../../../core/ports/identity-authentication.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, epoch, malformed, str } from '../../kernel/rail-adapter.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const UAE_PASS_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'UAEPASS-DEV-001',
    summary: 'The service returns the Emirates ID number, name, mobile and email of the authenticated person.',
    containment:
      'Only the assertion id, an opaque subject reference and the time are mapped; every attribute is dropped at this boundary and never stored or logged.',
    verificationRef: 'UAE-RAIL-UAEPASS-01',
  },
  {
    id: 'UAEPASS-DEV-002',
    summary: 'Accounts carry an assurance level: a basic (unverified) account and verified accounts.',
    containment:
      'A step-up or signing intent completed on a basic account is REFUSED with ASSURANCE_INSUFFICIENT; only a login may complete at the basic level. Which levels are verified is the verification item.',
    verificationRef: 'UAE-RAIL-UAEPASS-01',
  },
];

type Purpose = 'LOGIN' | 'STEP_UP' | 'SIGNATURE_INTENT';

/** Our purpose → the service's flow name. */
const FLOW: Readonly<Record<Purpose, string>> = {
  LOGIN: 'AUTHENTICATE',
  STEP_UP: 'AUTHENTICATE_STEP_UP',
  SIGNATURE_INTENT: 'SIGN',
};

/** Assurance levels the service reports, and whether each is a verified identity. */
const VERIFIED_LEVEL: Readonly<Record<string, boolean>> = { SOP1: false, SOP2: true, SOP3: true };

export class UaePassAdapter extends RailAdapter implements IdentityAuthenticationPort {
  readonly vendorName = 'UAE Pass';
  readonly capabilities = ['IDENTITY_AUTHENTICATION'] as const;
  readonly deviations = UAE_PASS_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async startAuthentication(p: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly purpose: Purpose;
    readonly correlationId: string;
  }) {
    const r = await this.invoke(
      'identity.start',
      { method: 'POST', path: '/v1/authorisations', body: { applicantRef: p.applicantRef, flow: FLOW[p.purpose] } },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const transactionRef = str(r.value['transactionId']);
    const expires = epoch(r.value['expiresAt']);
    return ok(
      transactionRef === undefined || expires === undefined
        ? malformed()
        : { kind: 'ANSWERED' as const, value: { transactionRef, expiresAtEpochSeconds: expires } },
    );
  }

  async confirmAuthentication(p: {
    readonly tenantId: string;
    readonly transactionRef: string;
    readonly correlationId: string;
  }) {
    const r = await this.invoke(
      'identity.confirm',
      { method: 'GET', path: `/v1/authorisations/${encodeURIComponent(p.transactionRef)}` },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    if (v['status'] !== 'COMPLETED')
      return ok({ kind: 'REFUSED' as const, code: `STATUS_${str(v['status']) ?? 'UNKNOWN'}` });
    const verifiedLevel = lookupStatus(VERIFIED_LEVEL, v['assuranceLevel']);
    // An assurance level we do not know is not a verified identity.
    if (verifiedLevel === undefined) return ok(malformed());
    if (!verifiedLevel && v['flow'] !== FLOW.LOGIN)
      return ok({ kind: 'REFUSED' as const, code: 'ASSURANCE_INSUFFICIENT' });
    const assertionId = str(v['assertionId']);
    const identityRef = str(v['subjectRef']);
    const at = epoch(v['completedAt']);
    return ok(
      assertionId === undefined || identityRef === undefined || at === undefined
        ? malformed()
        : { kind: 'ANSWERED' as const, value: { assertionId, identityRef, authenticatedAtEpochSeconds: at } },
    );
  }
}
