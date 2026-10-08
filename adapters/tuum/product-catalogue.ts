/**
 * Tuum product catalogue — the read-only implementation of
 * `CoreBankingProductCatalogue`.
 *
 * This is deliberately a separate file from `core-banking-adapter.ts`. That
 * adapter books obligations and refuses, at construction, any host that would
 * put a booking onto the lending module (README, Finding 1). This file never
 * books anything: it lists the lending module's product types and reads one
 * product's configuration, so that an administrator can see, before anything
 * is booked, which products exist and whether the platform would price them by
 * a rate. The product owner's decision of 2026-10-08 keeps the lending module
 * open for the rate-priced products; this is the view that decision needs.
 *
 * Verified against the partners sandbox on 2026-10-08 (README, "First verified
 * call" and "Steps A.2–A.5"): the list endpoint answers a type, a group, a
 * currency, a country, a status and a unit per product; the detail endpoint
 * answers the configuration sections mapped below. The product host comes from
 * the vault (`loan_api_base_url`), never from a literal here.
 */

import type { CoreBankingPricingComponent, CoreBankingProductCatalogue, CoreBankingProductDetail, CoreBankingProductType } from '../../core/ports/core-banking-catalogue.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { HttpTransport, type RailTransport, TransportError } from '../kernel/http-transport.ts';

import { type AuthHttp, type Envelope, type TuumAuthCredentials, type TuumSession, createTuumSession, errorCodes, fetchAuthHttp } from './authentication.ts';

export interface TuumCatalogueHosts {
  /** The authentication module's host. */
  readonly auth: string;
  /** The host that publishes product types and their configuration. */
  readonly products: string;
}

export class TuumProductCatalogue implements CoreBankingProductCatalogue {
  constructor(
    private readonly hosts: TuumCatalogueHosts,
    private readonly session: TuumSession,
    private readonly transport: RailTransport,
  ) {}

  async listProductTypes(correlationId: string): Promise<RailOutcome<readonly CoreBankingProductType[]>> {
    const body = await this.#get('product.list', `${this.hosts.products}/api/v1/loan-products`, correlationId);
    if (body.kind !== 'ANSWERED') return body;
    const rows = Array.isArray(body.value.data) ? body.value.data : [];
    return { kind: 'ANSWERED', value: rows.filter(isRecord).map(summaryOf) };
  }

  async describeProductType(code: string, correlationId: string): Promise<RailOutcome<CoreBankingProductDetail>> {
    const body = await this.#get('product.describe', `${this.hosts.products}/api/v2/loan-products/${encodeURIComponent(code)}`, correlationId);
    if (body.kind !== 'ANSWERED') return body;
    const data = body.value.data;
    if (!isRecord(data)) return { kind: 'REFUSED', code: 'PRODUCT_NOT_FOUND' };
    return { kind: 'ANSWERED', value: detailOf(code, data) };
  }

  async #get(operation: string, url: string, correlationId: string): Promise<RailOutcome<Envelope<unknown>>> {
    const headers = await this.session.authHeaders();
    if (!headers.ok) return { kind: 'UNAVAILABLE', reason: headers.error.reason };
    try {
      const envelope = (await this.transport.call(operation, { method: 'GET', url, headers: { ...headers.value, 'x-request-id': correlationId } })) as Envelope<unknown>;
      // A 200 can carry errors (authentication.ts, point 3).
      const codes = errorCodes(envelope);
      if (codes.length > 0) return { kind: 'REFUSED', code: codes[0] ?? 'err.unknown' };
      return { kind: 'ANSWERED', value: envelope };
    } catch (error) {
      if (error instanceof TransportError) {
        if (error.status === 401 || error.status === 403) this.session.invalidate();
        return { kind: 'UNAVAILABLE', reason: error.status === undefined ? 'TRANSPORT_FAILURE' : `HTTP_${String(error.status)}` };
      }
      return { kind: 'UNAVAILABLE', reason: 'TRANSPORT_FAILURE' };
    }
  }
}

export function createTuumProductCatalogue(params: {
  readonly hosts: TuumCatalogueHosts;
  /** Resolved from the credential store per authentication; never held here. */
  readonly credentials: () => Promise<TuumAuthCredentials>;
  readonly nowEpochSeconds: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly authHttp?: AuthHttp;
  readonly transport?: RailTransport;
}): TuumProductCatalogue {
  const session = createTuumSession({
    baseUrl: params.hosts.auth,
    http: params.authHttp ?? fetchAuthHttp(params.fetchImpl),
    credentials: params.credentials,
    nowEpochSeconds: params.nowEpochSeconds,
  });
  return new TuumProductCatalogue(params.hosts, session, params.transport ?? new HttpTransport(params.fetchImpl));
}

// -- Mapping: vendor vocabulary stops here --------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

function summaryOf(row: Record<string, unknown>): CoreBankingProductType {
  return {
    code: text(row['loanTypeCode']),
    description: text(row['loanTypeDescription'] ?? row['description']),
    group: text(row['loanGroupCode']),
    groupDescription: text(row['loanGroupDescription']),
    currency: text(row['currencyCode']),
    country: text(row['countryCode']),
    status: text(row['statusCode']),
    unit: text(row['tenantCode']),
  };
}

function detailOf(code: string, data: Record<string, unknown>): CoreBankingProductDetail {
  const general = isRecord(data['generalInfo']) ? data['generalInfo'] : {};
  const principal = isRecord(data['principal']) ? data['principal'] : {};
  const interest = isRecord(data['interest']) ? data['interest'] : undefined;
  const repayment = isRecord(data['repayment']) ? data['repayment'] : undefined;
  const origination = isRecord(data['origination']) ? data['origination'] : {};
  const pricing = isRecord(data['pricing']) ? data['pricing'] : {};
  const feeCodes = new Set((Array.isArray(data['fees']) ? data['fees'] : []).filter(isRecord).map((f) => text(f['componentTypeCode'] ?? f['feeTypeCode'])));

  const components: CoreBankingPricingComponent[] = [];
  for (const [component, entries] of Object.entries(pricing)) {
    for (const entry of Array.isArray(entries) ? entries.filter(isRecord) : []) {
      components.push({ component, kind: component === 'INT' ? 'RATE' : feeCodes.has(component) ? 'FEE' : 'OTHER', valueText: text(entry['value']) });
    }
  }

  const interestType = interest === undefined ? '' : text(interest['interestTypeCode']);
  const method = interest !== undefined && isRecord(interest['calculationMethod']) ? interest['calculationMethod'] : undefined;
  const dayCount = method === undefined ? '' : `${text(method['daysInMonth'])}/${text(method['daysInYear'])}`;
  const rateDriven = interestType.length > 0 || components.some((c) => c.kind === 'RATE');

  const amountRange = isRecord(principal['amountRange']) ? principal['amountRange'] : undefined;
  const periodRange = isRecord(principal['periodRange']) ? principal['periodRange'] : undefined;
  const periodLow = periodRange === undefined ? undefined : count(periodRange['startValue']);
  const periodHigh = periodRange === undefined ? undefined : count(periodRange['endValue']);

  return {
    summary: { ...summaryOf({ ...general, loanTypeCode: text(general['loanTypeCode']) || code }), description: text(general['description'] ?? general['loanTypeDescription']) },
    scheduleShape: text(general['scheduleTypeCode']),
    ...(amountRange === undefined ? {} : { amountLimits: { lowText: text(amountRange['startValue']), highText: text(amountRange['endValue']) } }),
    ...(periodLow === undefined || periodHigh === undefined ? {} : { periodLimits: { low: periodLow, high: periodHigh } }),
    pricingMethod: rateDriven ? 'RATE_DRIVEN' : interest === undefined && components.length === 0 ? 'UNKNOWN' : 'NOT_RATE_DRIVEN',
    ...(rateDriven ? { rateBasis: [interestType, dayCount].filter((s) => s.length > 1).join(' ') } : {}),
    components,
    ...(repayment === undefined ? {} : {
      repaymentCycle: {
        ...(count(repayment['paymentFrequency']) === undefined ? {} : { frequency: count(repayment['paymentFrequency']) as number }),
        ...(text(repayment['paymentFrequencyUnit']).length === 0 ? {} : { unit: text(repayment['paymentFrequencyUnit']) }),
        ...(count(repayment['invoiceTermDays']) === undefined ? {} : { invoiceTermDays: count(repayment['invoiceTermDays']) as number }),
        ...(count(repayment['minBillingPeriodDays']) === undefined ? {} : { minBillingPeriodDays: count(repayment['minBillingPeriodDays']) as number }),
      },
    }),
    reviewRequiredBeforeOffer: origination['applicationReviewRequired'] === true,
  };
}
