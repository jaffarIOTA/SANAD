/**
 * NER — business registry adapter (ADR 0005).
 *
 * Implements the BusinessRegistryPort against the National Economic
 * Register: trade licence, legal form, status, activities and the people who
 * control and manage the business. The port's key is named
 * `commercialRegistration`; for a UAE tenant it carries the trade licence
 * number (NER-DEV-001).
 *
 * ASSUMED CONTRACT. The register publishes no API specification. The shape
 * this adapter reads is modelled on the UK Companies House public data API
 * (company profile, officers, persons with significant control —
 * developer.company-information.service.gov.uk), extended with the fields the
 * NER publishes on its public search (economic register number, issuing
 * authority, licence expiry, ISIC4 activities). Field names are therefore an
 * analogue, not the register's specification, and remain verification item
 * UAE-RAIL-NER-01.
 *
 * Three reads, as Companies House offers them:
 *   GET /company/{licence}                                  the profile
 *   GET /company/{licence}/officers                         managers and directors
 *   GET /company/{licence}/persons-with-significant-control owners and controllers
 *
 * Names, dates of birth, nationalities and addresses of officers and owners
 * are dropped here; each becomes an opaque reference taken from the
 * resource link the register gives it.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { BusinessRegistryPort, RegistrationRecord } from '../../../core/ports/business-registry.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, malformed, str } from '../../kernel/rail-adapter.ts';
import { aedAmountObject } from '../kernel/dirham.ts';
import { isoEpoch } from '../kernel/iso-time.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const NER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'NER-DEV-001',
    summary:
      'The register keys a business on its trade licence number and issuing authority, not a commercial registration number.',
    containment:
      'The licence number travels in the port’s commercialRegistration field and is renamed only inside this adapter. Licence numbers differ in format by issuing authority, so the adapter checks shape only (letters, digits, hyphen, slash) and lets the register decide. A profile that echoes a different licence number is malformed.',
    verificationRef: 'UAE-RAIL-NER-01',
  },
  {
    id: 'NER-DEV-002',
    summary:
      'Officers and persons with significant control come back with names, dates of birth, nationalities and addresses (and, on the register, Emirates ID or passport numbers).',
    containment:
      'Each becomes an opaque reference taken from its resource link; every attribute is dropped at this boundary. A resigned officer or a ceased controller is not a signatory. An entry with no link, or a list shorter than its stated total, refuses the whole lookup rather than losing a signatory.',
    verificationRef: 'UAE-RAIL-NER-01',
  },
  {
    id: 'NER-DEV-003',
    summary: 'Share capital is an AED decimal; the port carries it as minor units without a currency.',
    containment:
      'Converted to AED minor units by digit manipulation; a capital stated in another currency is left out rather than relabelled.',
    verificationRef: 'UAE-RAIL-NER-01',
  },
  {
    id: 'NER-DEV-004',
    summary:
      'The register states a licence expiry date, an economic register number and an issuing authority; the port has no field for any of them.',
    containment:
      'An expiry date before the retrieval makes an "active" licence EXPIRED (the date is the stronger evidence). The economic register number and issuing authority do not cross the port; the naming debt is recorded against ADR 0005.',
    verificationRef: 'UAE-RAIL-NER-01',
  },
];

/** Companies House `company_status` values, plus the register's own (expired, suspended, frozen, cancelled, revoked). */
const STATUS: Readonly<Record<string, RegistrationRecord['status']>> = {
  active: 'ACTIVE',
  expired: 'EXPIRED',
  suspended: 'SUSPENDED',
  frozen: 'SUSPENDED',
  liquidation: 'SUSPENDED',
  administration: 'SUSPENDED',
  receivership: 'SUSPENDED',
  'insolvency-proceedings': 'SUSPENDED',
  'voluntary-arrangement': 'SUSPENDED',
  dissolved: 'CANCELLED',
  cancelled: 'CANCELLED',
  revoked: 'CANCELLED',
  removed: 'CANCELLED',
  closed: 'CANCELLED',
  'converted-closed': 'CANCELLED',
};

const LICENCE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/-]{2,29}$/;
const OFFICER_LINK = /^\/officers\/([A-Za-z0-9_-]{1,64})\/appointments$/;
const PSC_LINK = /^\/company\/[^/]+\/persons-with-significant-control\/[a-z-]+\/([A-Za-z0-9_-]{1,64})$/;
const ISIC4 = /^\d{4}(\.\d{1,2})?$/;

type Rec = Readonly<Record<string, unknown>>;
const rec = (v: unknown): Rec | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;

/**
 * The live entries of a Companies House-style list, as references. `undefined`
 * (malformed) when the list is truncated or an entry cannot be referenced.
 */
function references(
  list: Rec,
  linkOf: (item: Rec) => unknown,
  pattern: RegExp,
  endedKey: string,
): string[] | undefined {
  const items = list['items'];
  if (!Array.isArray(items)) return undefined;
  const total = list['total_results'];
  if (typeof total === 'number' && total > items.length) return undefined;
  const refs: string[] = [];
  for (const raw of items as unknown[]) {
    const item = rec(raw);
    if (item === undefined) return undefined;
    if (item[endedKey] !== undefined) continue;
    const link = linkOf(item);
    const m = typeof link === 'string' ? pattern.exec(link) : null;
    if (m?.[1] === undefined) return undefined;
    refs.push(m[1]);
  }
  return refs;
}

export class NerAdapter extends RailAdapter implements BusinessRegistryPort {
  readonly vendorName = 'NER';
  readonly capabilities = ['BUSINESS_REGISTRY'] as const;
  readonly deviations = NER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  /** `commercialRegistration` is the trade licence number (NER-DEV-001). `REFUSED` with `NOT_FOUND` when the register does not know it. */
  async lookup(p: {
    readonly tenantId: string;
    readonly commercialRegistration: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<RegistrationRecord>>> {
    const licence = p.commercialRegistration.trim();
    if (!LICENCE_SHAPE.test(licence))
      return reject(
        'OP-DETERMINACY',
        'LICENCE_MALFORMED',
        'A trade licence number is 3 to 30 letters, digits, hyphens or slashes',
      );
    const base = `/company/${encodeURIComponent(licence)}`;
    const profile = await this.invoke('registry.lookup', { method: 'GET', path: base }, p.correlationId);
    if (profile.kind === 'REFUSED' && profile.code === 'HTTP_404') return ok({ kind: 'REFUSED', code: 'NOT_FOUND' });
    if (profile.kind !== 'ANSWERED') return ok(profile);
    const v = profile.value;
    const retrievedAt = BigInt(this.config.nowEpochSeconds());

    const nameEn = str(v['company_name']);
    const nameAr = str(v['company_name_ar']);
    const type = str(v['type']);
    const echoed = str(v['company_number']);
    let status = lookupStatus(STATUS, v['company_status']);
    if (
      nameAr === undefined ||
      nameEn === undefined ||
      type === undefined ||
      status === undefined ||
      (echoed !== undefined && echoed !== licence)
    )
      return ok(malformed());
    const expiry = v['licence_expiry_date'] === undefined ? undefined : isoEpoch(v['licence_expiry_date']);
    if (v['licence_expiry_date'] !== undefined && expiry === undefined) return ok(malformed());
    if (status === 'ACTIVE' && expiry !== undefined && expiry < retrievedAt) status = 'EXPIRED';

    const activities = v['isic4_activities'];
    const activityCodes: string[] = [];
    if (Array.isArray(activities))
      for (const a of activities as unknown[]) {
        const code = str(rec(a)?.['code']);
        if (code === undefined || !ISIC4.test(code)) return ok(malformed());
        activityCodes.push(code);
      }

    const officers = await this.invoke(
      'registry.officers',
      { method: 'GET', path: `${base}/officers` },
      p.correlationId,
    );
    if (officers.kind !== 'ANSWERED') return ok(officers.kind === 'REFUSED' ? malformed() : officers);
    const controllers = await this.invoke(
      'registry.psc',
      { method: 'GET', path: `${base}/persons-with-significant-control` },
      p.correlationId,
    );
    if (controllers.kind !== 'ANSWERED') return ok(controllers.kind === 'REFUSED' ? malformed() : controllers);
    const officerRefs = references(
      officers.value,
      (i) => rec(rec(i['links'])?.['officer'])?.['appointments'],
      OFFICER_LINK,
      'resigned_on',
    );
    const controllerRefs = references(controllers.value, (i) => rec(i['links'])?.['self'], PSC_LINK, 'ceased_on');
    if (officerRefs === undefined || controllerRefs === undefined) return ok(malformed());

    const capital = aedAmountObject(v['share_capital'], 'amount', 'currency');
    const created = str(v['date_of_creation']);
    return ok({
      kind: 'ANSWERED',
      value: {
        commercialRegistration: licence,
        legalNameAr: nameAr,
        legalNameEn: nameEn,
        legalForm: type.toUpperCase().replaceAll('-', '_'),
        status,
        activityCodes,
        signatoryRefs: [...new Set([...controllerRefs, ...officerRefs])],
        lookupRef: str(v['etag']) ?? `ner-${licence}`,
        retrievedAtEpochSeconds: retrievedAt,
        ...(capital === undefined ? {} : { paidCapitalMinorUnits: capital.minorUnits }),
        ...(created === undefined || isoEpoch(created) === undefined ? {} : { registeredAtGregorian: created }),
      },
    });
  }
}
