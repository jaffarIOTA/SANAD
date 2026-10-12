/**
 * The demonstration transport for the UAE KYB rails.
 *
 * A fixture transport that answers by rule instead of from a recorded list, so
 * an officer can walk a whole intake on the hosted synthetic environment and
 * see every outcome a real register or identity authority can give. It speaks
 * each adapter's own envelope, so the adapters' mapping, consent checks and
 * typed outcomes run exactly as they will against the live rail; only the
 * answer is invented.
 *
 * It is selected only where a synthetic demonstration is permitted (the
 * process declares synthetic data and the database confirms it, SR-005);
 * everywhere else the rails are live or unavailable. Every answer it gives is
 * labelled FIXTURE wherever it is shown.
 *
 * The rules, so a demonstration can be steered from the form:
 *   registry  a licence starting EXP- is EXPIRED, SUS- is SUSPENDED, UNK- is
 *             not on the register (HTTP 404); any other licence is ACTIVE
 *   identity  an applicant reference containing "mismatch" does not match;
 *             any other reference matches a valid card
 */

import { type RailEnvelope, type RailTransport, TransportError } from '../../kernel/http-transport.ts';

/** The instant every demonstration answer carries; the adapters stamp their own times. */
const AS_OF = 1_800_000_000;

const tail = (url: string): string => decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));

function registry(envelope: RailEnvelope): Readonly<Record<string, unknown>> {
  const licence = tail(envelope.url);
  if (licence.startsWith('UNK-')) throw new TransportError('registry.lookup', 404, 'not on the register');
  const licenceStatus = licence.startsWith('EXP-') ? 'EXPIRED' : licence.startsWith('SUS-') ? 'SUSPENDED' : 'ACTIVE';
  return {
    tradeNameEn: 'Demonstration Trading LLC',
    tradeNameAr: 'شركة العرض التجريبي',
    legalForm: 'LLC',
    licenceStatus,
    asOf: AS_OF,
    lookupId: `ner-demo-${licence}`,
    shareCapital: '300000.00',
    capitalCurrency: 'AED',
    issuedAt: '2019-04-01',
    activities: [{ code: '4690.01' }],
    owners: [],
    managers: [],
  };
}

function identity(envelope: RailEnvelope): Readonly<Record<string, unknown>> {
  const applicantRef = String(envelope.body?.['applicantRef'] ?? '');
  const matched = !applicantRef.toLowerCase().includes('mismatch');
  return {
    matched,
    cardStatus: 'VALID',
    verificationId: `icp-demo-${applicantRef}`,
    verifiedAt: AS_OF,
    ...(matched ? {} : { mismatchedFields: ['name'] }),
  };
}

const RULES: Readonly<Record<string, (e: RailEnvelope) => Readonly<Record<string, unknown>>>> = {
  'registry.lookup': registry,
  'identity.verify': identity,
};

export class DemonstrationTransport implements RailTransport {
  async call(operation: string, envelope: RailEnvelope): Promise<Readonly<Record<string, unknown>>> {
    const rule = RULES[operation];
    // An operation without a rule is a gap in the demonstration, said plainly rather than answered.
    if (rule === undefined) throw new TransportError(operation, 501, `no demonstration rule for ${operation}`);
    return Promise.resolve(rule(envelope));
  }
}
