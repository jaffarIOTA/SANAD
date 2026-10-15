/**
 * Executing a Tawarruq between signature and disbursement (KSA K4): the four
 * commodity steps through the board-approved broker, each recorded only when
 * the broker confirms it and validated by products/sme-term-islamic.
 *
 * The rail is the fenced one: the Saudi demonstration transport, labelled
 * Fixture, only where a synthetic demonstration is permitted; elsewhere
 * UNAVAILABLE until adapters/ksa/commodity-broker has made a verified sandbox
 * call. A broker that refuses or is down records nothing (CLAUDE.md §5).
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import type { CommodityBrokerPort } from '@sanad/core/ports/commodity-broker.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import { CommodityBrokerAdapter } from '../../../../adapters/ksa/commodity-broker/adapter.ts';
import { KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { type BusinessApplicationView, recordTawarruqStep, tawarruqTermsOf } from './business.ts';
import { intakeConsentLedger } from './intake.ts';
import { DemonstrationCredentials, demonstrationConfig } from './intake-rails.ts';
import { persistencePool } from './persistence.ts';
import { developmentAttestation } from './store.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);
const unavailable = (): Result<never> =>
  fail('RAIL_UNAVAILABLE', 'The commodity broker is not connected here; nothing was recorded', { rail: 'COMMODITY_BROKER' });

const nowSeconds = (): number => Number(developmentAttestation().epochSeconds);

async function brokerFor(
  tenant: TenantCode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly port: CommodityBrokerPort; readonly source: 'LIVE' | 'FIXTURE' } | undefined> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(env), env))) return undefined;
  return {
    port: new CommodityBrokerAdapter(
      demonstrationConfig(tenant, 'COMMODITY_BROKER', await intakeConsentLedger(tenant), nowSeconds),
      new DemonstrationCredentials(),
      new KsaDemonstrationTransport(nowSeconds),
    ),
    source: 'FIXTURE',
  };
}

/** Treasury buys the commodity from the broker at exactly the quoted cost. */
export async function buyCommodity(tenant: TenantCode, applicationId: string, actor: string): Promise<Result<BusinessApplicationView>> {
  const terms = await tawarruqTermsOf(tenant, applicationId);
  if (!terms.ok) return terms;
  const broker = await brokerFor(tenant);
  if (broker === undefined) return unavailable();
  const r = await broker.port.purchase({
    tenantId: tenant,
    brokerRef: terms.value.brokerRef,
    commodityCode: terms.value.commodityCode,
    amount: terms.value.offer.facilityAmount,
    idempotencyKey: `business:${applicationId}:tawarruq:purchase`,
    correlationId: applicationId,
  });
  if (!r.ok) return r;
  if (r.value.kind !== 'ANSWERED') return r.value.kind === 'UNAVAILABLE' ? unavailable() : fail('BROKER_REFUSED', 'The broker did not confirm the purchase', { code: r.value.code });
  return recordTawarruqStep(tenant, applicationId, { step: 'COMMODITY_PURCHASED', lot: r.value.value }, broker.source, actor);
}

/** The institution sells the commodity to the customer for the deferred price, on the signed instrument. */
export async function sellCommodityToCustomer(
  tenant: TenantCode,
  applicationId: string,
  saleDocumentRef: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const broker = await brokerFor(tenant);
  if (broker === undefined) return unavailable();
  return recordTawarruqStep(tenant, applicationId, { step: 'SOLD_TO_CUSTOMER', saleDocumentRef }, broker.source, actor);
}

/** Title to the lot passes to the customer at the broker. */
export async function transferCommodityTitle(tenant: TenantCode, applicationId: string, actor: string): Promise<Result<BusinessApplicationView>> {
  const terms = await tawarruqTermsOf(tenant, applicationId);
  if (!terms.ok) return terms;
  const lot = terms.value.view.closing.tawarruq?.lot;
  if (lot === undefined) return fail('TAWARRUQ_STEP_OUT_OF_ORDER', 'Title passes once the commodity is bought and sold');
  const broker = await brokerFor(tenant);
  if (broker === undefined) return unavailable();
  const r = await broker.port.transferTitle({ tenantId: tenant, lotRef: lot.lotRef, toPartyRef: terms.value.view.contact.partyRef, correlationId: applicationId });
  if (!r.ok) return r;
  if (r.value.kind !== 'ANSWERED') return r.value.kind === 'UNAVAILABLE' ? unavailable() : fail('BROKER_REFUSED', 'The broker did not confirm the title transfer', { code: r.value.code });
  return recordTawarruqStep(tenant, applicationId, { step: 'TITLE_TRANSFERRED', transferRef: r.value.value.transferRef }, broker.source, actor);
}

/**
 * The commodity is sold on for cash: by the institution as the customer's
 * agent where the board permits it (with the customer's agency appointment),
 * otherwise by the customer through the broker.
 */
export async function sellCommodityOnBehalf(
  tenant: TenantCode,
  applicationId: string,
  agencyRef: string | undefined,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const terms = await tawarruqTermsOf(tenant, applicationId);
  if (!terms.ok) return terms;
  const lot = terms.value.view.closing.tawarruq?.lot;
  if (lot === undefined) return fail('TAWARRUQ_STEP_OUT_OF_ORDER', 'The commodity is sold on once title has passed');
  const broker = await brokerFor(tenant);
  if (broker === undefined) return unavailable();
  const r = await broker.port.sellOnBehalf({
    tenantId: tenant,
    lotRef: lot.lotRef,
    onBehalfOfPartyRef: terms.value.view.contact.partyRef,
    ...(agencyRef === undefined ? {} : { agencyRef }),
    idempotencyKey: `business:${applicationId}:tawarruq:onward-sale`,
    correlationId: applicationId,
  });
  if (!r.ok) return r;
  if (r.value.kind !== 'ANSWERED') return r.value.kind === 'UNAVAILABLE' ? unavailable() : fail('BROKER_REFUSED', 'The broker did not confirm the onward sale', { code: r.value.code });
  return recordTawarruqStep(
    tenant,
    applicationId,
    { step: 'PROCEEDS_REALISED', saleRef: r.value.value.saleRef, proceeds: r.value.value.proceeds, ...(agencyRef === undefined ? {} : { agencyRef }) },
    broker.source,
    actor,
  );
}
