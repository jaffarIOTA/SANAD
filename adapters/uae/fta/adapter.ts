/**
 * FTA — tax compliance adapter (ADR 0005).
 *
 * Implements the TaxCompliancePort against the Federal Tax Authority: is the
 * business registered for VAT. The port's key is named `crNumber`; a
 * fifteen-digit value is a Tax Registration Number, anything else is the
 * trade licence number (FTA-DEV-001).
 *
 * ASSUMED CONTRACT. The authority offers only a CAPTCHA-protected TRN check on
 * tax.gov.ae; it publishes no API. The answer this adapter reads is modelled
 * on the European Commission's VIES VAT-number validation REST service
 * (ec.europa.eu/taxation_customs/vies — `isValid`, `requestDate`,
 * `userError`, `name`, `address`, `requestIdentifier`), with the TRN as the
 * FTA publishes it (fifteen digits) and two statuses VIES does not have
 * (SUSPENDED, DEREGISTERED). Field names are an analogue and remain
 * verification item UAE-RAIL-FTA-01.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { TaxCompliancePort } from '../../../core/ports/tax-compliance.ts';
import { ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, bool, malformed, str } from '../../kernel/rail-adapter.ts';
import { isoEpoch } from '../kernel/iso-time.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const FTA_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'FTA-DEV-001',
    summary:
      'The authority keys a taxpayer on its Tax Registration Number (fifteen digits); the port field is named crNumber.',
    containment:
      'A fifteen-digit value is checked as the TRN, anything else is sent as the trade licence for the authority to resolve. The port is not renamed; the naming debt is recorded against ADR 0005.',
    verificationRef: 'UAE-RAIL-FTA-01',
  },
  {
    id: 'FTA-DEV-002',
    summary:
      'Validation outcomes follow VIES `userError` (VALID, INVALID, INVALID_INPUT, SERVICE_UNAVAILABLE …) plus SUSPENDED and DEREGISTERED; an unregistered business may simply be below the registration threshold.',
    containment:
      'VALID with isValid true → VALID; INVALID → NOT_FOUND; DEREGISTERED → EXPIRED; SUSPENDED → SUSPENDED; a service-side outcome → UNAVAILABLE; an input or blocking outcome → REFUSED. isValid that contradicts the outcome, or an outcome we do not know, is malformed. Whether NOT_FOUND matters is the tenant’s credit policy.',
    verificationRef: 'UAE-RAIL-FTA-01',
  },
  {
    id: 'FTA-DEV-003',
    summary: 'The answer names the registered legal name and address; the port has no field for either.',
    containment:
      'Dropped at this boundary. The VIES-style requestIdentifier is the consultation reference and becomes certificateRef. Cross-checking the tax name against the register’s name would need a port field.',
    verificationRef: 'UAE-RAIL-FTA-01',
  },
];

type Outcome =
  | {
      readonly kind: 'STATUS';
      readonly status: 'VALID' | 'EXPIRED' | 'NOT_FOUND' | 'SUSPENDED';
      readonly valid: boolean;
    }
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'REFUSED' };
const OUTCOME: Readonly<Record<string, Outcome>> = {
  VALID: { kind: 'STATUS', status: 'VALID', valid: true },
  INVALID: { kind: 'STATUS', status: 'NOT_FOUND', valid: false },
  DEREGISTERED: { kind: 'STATUS', status: 'EXPIRED', valid: false },
  SUSPENDED: { kind: 'STATUS', status: 'SUSPENDED', valid: false },
  SERVICE_UNAVAILABLE: { kind: 'UNAVAILABLE' },
  MS_UNAVAILABLE: { kind: 'UNAVAILABLE' },
  TIMEOUT: { kind: 'UNAVAILABLE' },
  GLOBAL_MAX_CONCURRENT_REQ: { kind: 'UNAVAILABLE' },
  MS_MAX_CONCURRENT_REQ: { kind: 'UNAVAILABLE' },
  INVALID_INPUT: { kind: 'REFUSED' },
  VAT_BLOCKED: { kind: 'REFUSED' },
  IP_BLOCKED: { kind: 'REFUSED' },
};

const TRN = /^\d{15}$/;
const LICENCE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/-]{2,29}$/;

export class FtaAdapter extends RailAdapter implements TaxCompliancePort {
  readonly vendorName = 'FTA';
  readonly capabilities = ['TAX_COMPLIANCE'] as const;
  readonly deviations = FTA_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async certificateStatus(p: { readonly tenantId: string; readonly crNumber: string; readonly correlationId: string }) {
    const key = p.crNumber.trim();
    let path: string;
    if (TRN.test(key)) path = `/v1/vat-registrations/${key}`;
    else if (LICENCE_SHAPE.test(key)) path = `/v1/vat-registrations?licence=${encodeURIComponent(key)}`;
    else
      return reject(
        'OP-DETERMINACY',
        'TAX_KEY_MALFORMED',
        'A tax registration number is fifteen digits; a trade licence number is 3 to 30 letters, digits, hyphens or slashes',
      );
    const r = await this.invoke('tax.registration', { method: 'GET', path }, p.correlationId);
    // An unknown taxpayer the authority answers for is INVALID in the body; a bare 404 is a refusal, as with the registry.
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return ok({ kind: 'REFUSED' as const, code: 'NOT_FOUND' });
    if (r.kind !== 'ANSWERED') return ok(r);
    const v = r.value;
    const outcome = lookupStatus(OUTCOME, v['userError']);
    if (outcome === undefined) return ok(malformed());
    if (outcome.kind === 'UNAVAILABLE')
      return ok({ kind: 'UNAVAILABLE' as const, reason: `validation service: ${String(v['userError'])}` });
    if (outcome.kind === 'REFUSED') return ok({ kind: 'REFUSED' as const, code: String(v['userError']) });
    const isValid = bool(v['isValid']);
    const at = isoEpoch(v['requestDate']);
    const trn = v['vatNumber'];
    if (
      isValid === undefined ||
      isValid !== outcome.valid ||
      at === undefined ||
      (trn !== undefined && (typeof trn !== 'string' || !TRN.test(trn) || (TRN.test(key) && trn !== key)))
    )
      return ok(malformed());
    const ref = str(v['requestIdentifier']);
    return ok({
      kind: 'ANSWERED' as const,
      value: {
        status: outcome.status,
        retrievedAtEpochSeconds: at,
        ...(ref === undefined ? {} : { certificateRef: ref }),
      },
    });
  }
}
