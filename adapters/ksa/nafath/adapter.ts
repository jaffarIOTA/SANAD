/**
 * Nafath — identity authentication adapter (CLAUDE.md §5).
 *
 * Implements the IdentityAuthenticationPort. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 *
 * Assumed contract (third-party published, unconfirmed — see README.md): the
 * multi-factor flow at `/api/v1/mfa/request` answers `{ transId, random }`;
 * the person picks `random` in the Nafath app; `/api/v1/mfa/request/status`
 * answers `status` WAITING | COMPLETED | REJECTED | EXPIRED | ERROR, and a
 * completed transaction carries the decoded, gateway-verified callback claims.
 * A transaction lives 200 seconds.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import { ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import {
  RailAdapter,
  type RailAdapterConfig,
  epoch,
  idStr,
  isoToEpoch,
  malformed,
  own,
  str,
} from '../kernel/rail-adapter.ts';
import type { IdentityAuthenticationPort } from '../../../core/ports/identity-authentication.ts';

export const NAFATHADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'NAFATH-DEV-001',
    summary: 'The service identifies the person by national identifier in its own request.',
    containment:
      'The port takes an applicant reference; the mapping from reference to identifier happens in the institution’s egress, is never logged, and the identifier is not returned. The completed claims’ identifier is dropped here.',
    verificationRef: 'KSA-RAIL-NAFATH-01',
  },
  {
    id: 'NAFATH-DEV-002',
    summary:
      'A transaction is two values, transId and the random number the person must pick in the Nafath app; the port carries one opaque transaction reference.',
    containment:
      'The adapter packs both into the transaction reference ("transId:random") and unpacks them for the status call. Showing the random number to the applicant needs a port field (verification item).',
    verificationRef: 'KSA-RAIL-NAFATH-01',
  },
];

/** The published lifetime of one Nafath transaction (third-party integrations), in seconds. */
export const NAFATH_TRANSACTION_SECONDS = 200n;

/** Statuses that end a transaction without an identity; WAITING is the person not having answered yet. */
const NOT_COMPLETED: Readonly<Record<string, string>> = {
  WAITING: 'STATUS_WAITING',
  REJECTED: 'STATUS_REJECTED',
  EXPIRED: 'STATUS_EXPIRED',
  ERROR: 'STATUS_ERROR',
};

/** Sanad's purpose to the Nafath service name the request carries (unconfirmed; the tenant's Nafath profile decides). */
const SERVICE: Readonly<Record<'LOGIN' | 'STEP_UP' | 'SIGNATURE_INTENT', string>> = {
  LOGIN: 'Login',
  STEP_UP: 'Login',
  SIGNATURE_INTENT: 'DigitalSignature',
};

/** "transId:random" — the two values a Nafath status call needs, as one opaque reference. */
export const packTransaction = (transId: string, random: string): string => `${transId}:${random}`;
const unpack = (ref: string): { transId: string; random: string } | undefined => {
  const i = ref.lastIndexOf(':');
  if (i <= 0 || i === ref.length - 1) return undefined;
  return { transId: ref.slice(0, i), random: ref.slice(i + 1) };
};

export class NafathAdapter extends RailAdapter implements IdentityAuthenticationPort {
  readonly vendorName = 'Nafath';
  readonly capabilities = ['IDENTITY_AUTHENTICATION'] as const;
  readonly deviations = NAFATHADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async startAuthentication(p: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly purpose: 'LOGIN' | 'STEP_UP' | 'SIGNATURE_INTENT';
    readonly correlationId: string;
  }) {
    const r = await this.invoke(
      'identity.start',
      {
        method: 'POST',
        path: `/api/v1/mfa/request?local=ar&requestId=${encodeURIComponent(p.correlationId)}`,
        // The egress resolves applicantRef to the national identifier Nafath expects; it never comes back.
        body: { applicantRef: p.applicantRef, service: SERVICE[p.purpose] },
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const transId = str(r.value['transId']);
    const random = idStr(r.value['random']);
    if (transId === undefined || random === undefined || !/^\d{1,3}$/.test(random)) return ok(malformed());
    const started = BigInt(this.config.nowEpochSeconds());
    return ok({
      kind: 'ANSWERED' as const,
      value: {
        transactionRef: packTransaction(transId, random),
        expiresAtEpochSeconds: started + NAFATH_TRANSACTION_SECONDS,
      },
    });
  }

  async confirmAuthentication(p: {
    readonly tenantId: string;
    readonly transactionRef: string;
    readonly correlationId: string;
  }) {
    const tx = unpack(p.transactionRef);
    if (tx === undefined)
      return reject('OP-DETERMINACY', 'TRANSACTION_REF_MALFORMED', 'This is not a Nafath transaction reference');
    const r = await this.invoke(
      'identity.confirm',
      { method: 'POST', path: '/api/v1/mfa/request/status', body: { transId: tx.transId, random: tx.random } },
      p.correlationId,
    );
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED' as const, code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const status = str(r.value['status']);
    if (status !== 'COMPLETED') {
      const code = own(NOT_COMPLETED, status);
      return ok(code === undefined ? malformed() : { kind: 'REFUSED' as const, code });
    }
    // The completed transaction is the assertion: its transId is unique, and a status for another transaction is not ours.
    const assertionId = str(r.value['transId']);
    if (assertionId === undefined || assertionId !== tx.transId) return ok(malformed());
    // `iat` of the verified callback token; an ISO time where the gateway relays it that way.
    const at = epoch(r.value['iat']) ?? isoToEpoch(r.value['completedAt']);
    if (at === undefined) return ok(malformed());
    // Once, fresh, for this tenant: a captured assertion signs no one in twice (SR-007).
    const refused = await this.acceptAssertion(p.tenantId, assertionId, at);
    if (refused !== undefined) return ok({ kind: 'REFUSED' as const, code: refused });
    // The identity reference points at the completed Nafath transaction, never at the identifier it carried.
    return ok({
      kind: 'ANSWERED' as const,
      value: { assertionId, identityRef: `nafath:${assertionId}`, authenticatedAtEpochSeconds: at },
    });
  }
}
