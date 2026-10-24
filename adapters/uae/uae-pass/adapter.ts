/**
 * UAE Pass — identity authentication adapter (ADR 0005).
 *
 * Implements the IdentityAuthenticationPort: login, step-up, and the signing
 * intent that anchors an electronic signature. The national digital identity
 * answers with the person's Emirates ID and profile; only an opaque subject
 * reference and the assertion cross the port.
 *
 * MODELLED ON THE PUBLISHED INTEGRATION (docs.uaepass.ae):
 *   - login and step-up are the OpenID Connect authorisation-code flow
 *     (`/idshub/authorize`, then the token and `/idshub/userinfo` endpoints),
 *     with the published userinfo claims — `sub`, `uuid`, `userType`
 *     (SOP1 / SOP2 / SOP3), `idn` (only at SOP2/3), names, nationality,
 *     mobile, email;
 *   - the signing intent is a signer process,
 *     `POST /trustedx-resources/esignsp/v2/signer_processes`, read back by id,
 *     whose result `status` is finished | failed | failed_documents | canceled.
 * What is NOT published, and is therefore Sanad's assumption and verification
 * item UAE-RAIL-UAEPASS-01: the server-side envelope the live transport hands
 * this adapter (`state` / `expires_in` on start, decoded `id_token` claims
 * beside `userinfo` on confirm, `signer` and `finished_at` on a signer
 * process), the in-progress signer status name, and a signer process's
 * lifetime.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { IdentityAuthenticationPort } from '../../../core/ports/identity-authentication.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, epoch, int, malformed, str } from '../../kernel/rail-adapter.ts';
import { isoEpoch } from '../kernel/iso-time.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const UAE_PASS_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'UAEPASS-DEV-001',
    summary:
      'The userinfo claims carry the Emirates ID number (idn), names, nationality, gender, mobile and email of the authenticated person.',
    containment:
      'Only the id token’s jti (as the assertion id), the subject (sub) and auth_time are mapped; every other claim is dropped at this boundary and never stored or logged. A userinfo subject that differs from the id token’s is malformed.',
    verificationRef: 'UAE-RAIL-UAEPASS-01',
  },
  {
    id: 'UAEPASS-DEV-002',
    summary: 'Accounts carry an assurance level in userType: SOP1 (basic, unverified), SOP2 and SOP3 (verified).',
    containment:
      'A step-up or signing intent completed at SOP1 is REFUSED with ASSURANCE_INSUFFICIENT; only a login may complete at SOP1. An unknown userType is malformed, never verified.',
    verificationRef: 'UAE-RAIL-UAEPASS-01',
  },
  {
    id: 'UAEPASS-DEV-003',
    summary: 'UAE Pass signs documents within a signer process; the port passes the document by its SHA-256, not its bytes.',
    containment:
      'SIGNATURE_INTENT opens a signer process with the published process type and policy, and — when the caller gives one — the document’s SHA-256 as a digest entry. How the document itself reaches the signer process (upload or by reference) is part of the verification item; until then the binding is the digest on the intent and the letter version Sanad records against the signature.',
    verificationRef: 'UAE-RAIL-UAEPASS-01',
  },
  {
    id: 'UAEPASS-DEV-004',
    summary: 'The port’s transaction reference is one opaque string; UAE Pass has two kinds of transaction.',
    containment:
      'The adapter prefixes its own reference (login:, stepup:, sign:) so confirmation knows which flow, and at which assurance, it is confirming. An unknown prefix is refused without a call.',
    verificationRef: 'UAE-RAIL-UAEPASS-01',
  },
];

type Purpose = 'LOGIN' | 'STEP_UP' | 'SIGNATURE_INTENT';

const PREFIX: Readonly<Record<Purpose, string>> = { LOGIN: 'login', STEP_UP: 'stepup', SIGNATURE_INTENT: 'sign' };
const PURPOSE_OF: Readonly<Record<string, Purpose>> = { login: 'LOGIN', stepup: 'STEP_UP', sign: 'SIGNATURE_INTENT' };

/** userType, and whether each is a verified identity. */
const VERIFIED_LEVEL: Readonly<Record<string, boolean>> = { SOP1: false, SOP2: true, SOP3: true };

/** OAuth 2.0 error codes (RFC 6749 §4.1.2.1, RFC 8628 §3.5) → our refusal codes. */
const OAUTH_ERROR: Readonly<Record<string, string>> = {
  authorization_pending: 'STATUS_PENDING',
  slow_down: 'STATUS_PENDING',
  access_denied: 'STATUS_REJECTED',
  expired_token: 'STATUS_EXPIRED',
  invalid_grant: 'STATUS_EXPIRED',
  login_required: 'STATUS_REJECTED',
};

/** A signer process result. `active` (in progress) is not in the published list and is the verification item. */
const SIGNER_STATUS: Readonly<Record<string, string | undefined>> = {
  finished: undefined,
  active: 'STATUS_PENDING',
  failed: 'STATUS_FAILED',
  failed_documents: 'STATUS_FAILED_DOCUMENTS',
  canceled: 'STATUS_CANCELED',
};

/** Published values for a server-side qualified signature. */
const SIGNER_PROCESS = {
  process_type: 'urn:safelayer:eidas:processes:document:sign:esigp',
  labels: [['digitalid', 'server', 'qualified']],
  signer: {
    signature_policy_id: 'urn:safelayer:eidas:policies:sign:document:pdf',
    parameters: { type: 'pades-baseline' },
  },
  ui_locales: ['ar_AE', 'en_US'],
} as const;
/** A signer process publishes no lifetime; this is the window the adapter allows (verification item). */
export const SIGNER_PROCESS_WINDOW_SECONDS = 900n;

type Rec = Readonly<Record<string, unknown>>;
const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});

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
    readonly documentHash?: string;
    readonly correlationId: string;
  }) {
    const now = BigInt(this.config.nowEpochSeconds());
    if (p.purpose === 'SIGNATURE_INTENT') {
      const r = await this.invoke(
        'signature.start',
        {
          method: 'POST',
          path: '/trustedx-resources/esignsp/v2/signer_processes',
          body: {
            ...SIGNER_PROCESS,
            state: p.applicantRef,
            ...(p.documentHash === undefined
              ? {}
              : { documents: [{ name: 'offer-letter', digest: { algorithm: 'SHA-256', value: p.documentHash } }] }),
          },
        },
        p.correlationId,
      );
      if (r.kind !== 'ANSWERED') return ok(r);
      const id = str(r.value['id']);
      const pending = rec(r.value['tasks'])['pending'];
      return ok(
        id === undefined || !Array.isArray(pending) || pending.length === 0
          ? malformed()
          : {
              kind: 'ANSWERED' as const,
              value: {
                transactionRef: `${PREFIX.SIGNATURE_INTENT}:${id}`,
                expiresAtEpochSeconds: now + SIGNER_PROCESS_WINDOW_SECONDS,
              },
            },
      );
    }
    const r = await this.invoke(
      'identity.start',
      {
        method: 'POST',
        path: '/idshub/authorize',
        body: {
          response_type: 'code',
          scope: 'urn:uae:digitalid:profile:general',
          acr_values: 'urn:safelayer:tws:policies:authentication:level:low',
          ui_locales: 'ar',
          state: p.applicantRef,
        },
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const state = str(r.value['state']);
    const ttl = int(r.value['expires_in']);
    return ok(
      state === undefined || ttl === undefined || ttl <= 0
        ? malformed()
        : {
            kind: 'ANSWERED' as const,
            value: { transactionRef: `${PREFIX[p.purpose]}:${state}`, expiresAtEpochSeconds: now + BigInt(ttl) },
          },
    );
  }

  async confirmAuthentication(p: {
    readonly tenantId: string;
    readonly transactionRef: string;
    readonly correlationId: string;
  }) {
    const colon = p.transactionRef.indexOf(':');
    const purpose = colon < 0 ? undefined : lookupStatus(PURPOSE_OF, p.transactionRef.slice(0, colon));
    const id = p.transactionRef.slice(colon + 1);
    if (purpose === undefined || id.length === 0)
      return ok({ kind: 'REFUSED' as const, code: 'TRANSACTION_REF_UNKNOWN' });

    let assertionId: string | undefined;
    let identityRef: string | undefined;
    let at: bigint | undefined;
    let level: boolean | undefined;
    if (purpose === 'SIGNATURE_INTENT') {
      const r = await this.invoke(
        'signature.confirm',
        { method: 'GET', path: `/trustedx-resources/esignsp/v2/signer_processes/${encodeURIComponent(id)}` },
        p.correlationId,
      );
      if (r.kind !== 'ANSWERED') return ok(r);
      const status = r.value['status'];
      if (typeof status !== 'string' || !Object.hasOwn(SIGNER_STATUS, status)) return ok(malformed());
      const refusal = SIGNER_STATUS[status];
      if (refusal !== undefined) return ok({ kind: 'REFUSED' as const, code: refusal });
      const signer = rec(r.value['signer']);
      level = lookupStatus(VERIFIED_LEVEL, signer['userType']);
      assertionId = str(r.value['id']);
      identityRef = str(signer['sub']);
      at = isoEpoch(r.value['finished_at']);
    } else {
      const r = await this.invoke(
        'identity.confirm',
        { method: 'GET', path: `/idshub/userinfo?state=${encodeURIComponent(id)}` },
        p.correlationId,
      );
      if (r.kind !== 'ANSWERED') return ok(r);
      const error = r.value['error'];
      if (error !== undefined)
        return ok({ kind: 'REFUSED' as const, code: lookupStatus(OAUTH_ERROR, error) ?? 'STATUS_UNKNOWN' });
      const token = rec(r.value['id_token']);
      const userinfo = rec(r.value['userinfo']);
      level = lookupStatus(VERIFIED_LEVEL, userinfo['userType']);
      assertionId = str(token['jti']);
      identityRef = str(token['sub']);
      at = epoch(token['auth_time']);
      if (identityRef !== undefined && userinfo['sub'] !== identityRef) return ok(malformed());
    }
    // An assurance level we do not know is not a verified identity.
    if (level === undefined) return ok(malformed());
    if (!level && purpose !== 'LOGIN') return ok({ kind: 'REFUSED' as const, code: 'ASSURANCE_INSUFFICIENT' });
    if (assertionId === undefined || identityRef === undefined || at === undefined) return ok(malformed());
    // Once, fresh, for this tenant: a captured assertion signs no one in twice (SR-007).
    const refused = await this.acceptAssertion(p.tenantId, assertionId, at);
    if (refused !== undefined) return ok({ kind: 'REFUSED' as const, code: refused });
    return ok({ kind: 'ANSWERED' as const, value: { assertionId, identityRef, authenticatedAtEpochSeconds: at } });
  }
}
