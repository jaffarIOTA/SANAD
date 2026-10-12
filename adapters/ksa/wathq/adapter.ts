/**
 * Wathq — business registry adapter (CLAUDE.md §5).
 *
 * Implements the business-registry port: a lookup by commercial registration
 * against the Ministry of Commerce data.
 *
 * Assumed contract (third-party summary of the Wathq sandbox specification
 * v6.7.0 and the Lean Technologies wrapper — unconfirmed, see README.md):
 * `GET /v5/commercialregistration/fullinfo/{id}` answers `crNationalNumber`,
 * `crNumber`, `name`, `status{id,name}`, `entityType{...}`, `parties[]`,
 * `management.managers[]` and `activities[]`. Published errors: 400.1.1–400.1.7
 * and 404.2.1 (not found). Only status id 1 "Active" is published.
 *
 * Party and manager identifiers are dropped at this boundary; the record
 * carries opaque references only.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { BusinessRegistryPort, RegistrationRecord } from '../../../core/ports/business-registry.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import {
  RailAdapter,
  type RailAdapterConfig,
  arr,
  idStr,
  isoToEpoch,
  malformed,
  obj,
  own,
  str,
} from '../kernel/rail-adapter.ts';
import { sar } from '../kernel/riyal.ts';

export const WATHQ_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'WATHQ-DEV-002',
    summary: 'The registry returns the parties’ and managers’ national identifiers.',
    containment:
      'Identifiers are dropped at this boundary; each manager becomes an opaque reference by its position in this lookup.',
    verificationRef: 'KSA-RAIL-WATHQ-01',
  },
  {
    id: 'WATHQ-DEV-003',
    summary: 'Only status id 1 ("Active") is published; ids 2–4 are assumptions.',
    containment: 'A status id not in the table — including any inherited object key — is UNAVAILABLE, never ACTIVE.',
    verificationRef: 'KSA-RAIL-WATHQ-01',
  },
];

/**
 * Wathq `status.id` to the port. Only 1 is published; 2, 3 and 4 are this adapter's assumptions
 * and the verification item (README.md).
 */
export const WATHQ_STATUS: Readonly<Record<string, RegistrationRecord['status']>> = {
  '1': 'ACTIVE',
  '2': 'SUSPENDED',
  '3': 'CANCELLED',
  '4': 'EXPIRED',
};

export class WathqAdapter extends RailAdapter implements BusinessRegistryPort {
  readonly vendorName = 'Wathq';
  readonly capabilities = ['BUSINESS_REGISTRY'] as const;
  readonly deviations = WATHQ_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async lookup(p: {
    readonly tenantId: string;
    readonly commercialRegistration: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<RegistrationRecord>>> {
    if (!/^\d{10}$/.test(p.commercialRegistration))
      return reject('OP-DETERMINACY', 'CR_MALFORMED', 'A commercial registration number is ten digits');
    const r = await this.invoke(
      'registry.lookup',
      { method: 'GET', path: `/v5/commercialregistration/fullinfo/${p.commercialRegistration}` },
      p.correlationId,
    );
    // 404.2.1: no registration under this number.
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED', code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    const nationalNumber = idStr(v['crNationalNumber']);
    const crNumber = idStr(v['crNumber']);
    // The answer must be about the registration asked for, by either of its numbers.
    if (nationalNumber !== p.commercialRegistration && crNumber !== p.commercialRegistration) return ok(malformed());
    const nameAr = str(v['name']);
    const entityType = obj(v['entityType']);
    const legalForm = str(entityType?.['formName']) ?? str(entityType?.['name']);
    // Own keys only: a status of "constructor" is not understood, not Object.prototype.constructor.
    const status = own(WATHQ_STATUS, obj(v['status'])?.['id']);
    if (nameAr === undefined || legalForm === undefined || status === undefined) return ok(malformed());

    const managers = arr(obj(v['management'])?.['managers']) ?? [];
    const activities = arr(v['activities']) ?? [];
    const activityCodes: string[] = [];
    for (const a of activities) {
      const code = idStr(obj(a)?.['id']);
      if (code === undefined) return ok(malformed());
      activityCodes.push(code);
    }
    const now = BigInt(this.config.nowEpochSeconds());
    const lookupRef = `wathq:${nationalNumber ?? p.commercialRegistration}:${now.toString()}`;
    const capital = sar(obj(obj(v['capital'])?.['stockCapital'])?.['paidAmount'] ?? obj(v['capital'])?.['paidAmount']);
    const registered = str(v['issueDateGregorian']);
    return ok({
      kind: 'ANSWERED',
      value: {
        commercialRegistration: p.commercialRegistration,
        legalNameAr: nameAr,
        // An English trade name is optional on a Saudi CR; the Arabic name is the legal name.
        legalNameEn: str(v['nameEn']) ?? nameAr,
        legalForm,
        status,
        activityCodes,
        // Opaque, positional references: no manager's identifier leaves this adapter.
        signatoryRefs: managers.map(
          (_m, i) => `wathq:${nationalNumber ?? p.commercialRegistration}:manager:${String(i + 1)}`,
        ),
        lookupRef,
        retrievedAtEpochSeconds: now,
        ...(capital === undefined ? {} : { paidCapitalMinorUnits: capital.minorUnits }),
        ...(registered === undefined || isoToEpoch(registered) === undefined
          ? {}
          : { registeredAtGregorian: registered }),
      },
    });
  }
}
