/**
 * NER — business registry adapter (ADR 0005).
 *
 * Implements the BusinessRegistryPort against the National Economic
 * Register: trade licence, legal form, owners and licence status. The port's
 * key is named `commercialRegistration`; for a UAE tenant it carries the trade
 * licence number (NER-DEV-001). Owner identifiers are dropped at this
 * boundary; the record carries references only.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { BusinessRegistryPort, RegistrationRecord } from '../../../core/ports/business-registry.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, epoch, malformed, str } from '../../kernel/rail-adapter.ts';
import { aed } from '../kernel/dirham.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const NER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'NER-DEV-001',
    summary: 'The register keys a business on its trade licence number and issuing authority, not a commercial registration number.',
    containment: 'The licence number travels in the port’s commercialRegistration field and is renamed only inside this adapter. Licence numbers differ in format by issuing authority, so the adapter checks shape only (letters, digits, hyphen, slash) and lets the register decide.',
    verificationRef: 'UAE-RAIL-NER-01',
  },
  {
    id: 'NER-DEV-002',
    summary: 'The register returns owners and managers with their Emirates ID or passport numbers.',
    containment: 'Identifiers are dropped at this boundary; owners and managers become opaque signatory references.',
    verificationRef: 'UAE-RAIL-NER-01',
  },
  {
    id: 'NER-DEV-003',
    summary: 'Share capital is an AED decimal; the port carries it as minor units without a currency.',
    containment: 'Converted to AED minor units by digit manipulation; a capital stated in another currency is left out rather than relabelled.',
    verificationRef: 'UAE-RAIL-NER-01',
  },
];

const STATUS: Readonly<Record<string, RegistrationRecord['status']>> = { ACTIVE: 'ACTIVE', EXPIRED: 'EXPIRED', SUSPENDED: 'SUSPENDED', FROZEN: 'SUSPENDED', CANCELLED: 'CANCELLED', REVOKED: 'CANCELLED' };

const LICENCE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/-]{2,29}$/;

/** The named string field of each object in a list; anything else in the entries is dropped. */
const fieldOf = (list: unknown, key: string): string[] =>
  Array.isArray(list)
    ? (list as unknown[]).flatMap((x) => {
        const value = typeof x === 'object' && x !== null ? str((x as Record<string, unknown>)[key]) : undefined;
        return value === undefined ? [] : [value];
      })
    : [];

export class NerAdapter extends RailAdapter implements BusinessRegistryPort {
  readonly vendorName = 'NER';
  readonly capabilities = ['BUSINESS_REGISTRY'] as const;
  readonly deviations = NER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  /** `commercialRegistration` is the trade licence number (NER-DEV-001). `REFUSED` with `NOT_FOUND` when the register does not know it. */
  async lookup(p: { readonly tenantId: string; readonly commercialRegistration: string; readonly correlationId: string }): Promise<Result<RailOutcome<RegistrationRecord>>> {
    const licence = p.commercialRegistration.trim();
    if (!LICENCE_SHAPE.test(licence)) return reject('OP-DETERMINACY', 'LICENCE_MALFORMED', 'A trade licence number is 3 to 30 letters, digits, hyphens or slashes');
    const r = await this.invoke('registry.lookup', { method: 'GET', path: `/v1/trade-licences/${encodeURIComponent(licence)}` }, p.correlationId);
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED', code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    const nameAr = str(v['tradeNameAr']); const nameEn = str(v['tradeNameEn']); const legalForm = str(v['legalForm']); const status = lookupStatus(STATUS, v['licenceStatus']); const at = epoch(v['asOf']);
    if (nameAr === undefined || nameEn === undefined || legalForm === undefined || status === undefined || at === undefined) return ok(malformed());
    const lookupRef = str(v['lookupId']) ?? `ner-${licence}`;
    const signatoryRefs = [...new Set([...fieldOf(v['owners'], 'ref'), ...fieldOf(v['managers'], 'ref')])];
    const activityCodes = fieldOf(v['activities'], 'code');
    const capital = aed(v['shareCapital'], v['capitalCurrency']); const issued = str(v['issuedAt']);
    return ok({ kind: 'ANSWERED', value: { commercialRegistration: licence, legalNameAr: nameAr, legalNameEn: nameEn, legalForm, status, activityCodes, signatoryRefs, lookupRef, retrievedAtEpochSeconds: at, ...(capital === undefined ? {} : { paidCapitalMinorUnits: capital.minorUnits }), ...(issued === undefined ? {} : { registeredAtGregorian: issued }) } });
  }
}
