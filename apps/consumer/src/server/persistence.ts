/**
 * The consumer journey's records on PostgreSQL (migration 0011): offers,
 * acceptances, checkout sessions and the merchant's idempotency keys.
 *
 * The stores keep their synchronous working sets; this module is the SQL that
 * makes them durable. An offer and an acceptance are written once and never
 * changed — the tables refuse an update — and "accepted once" is the
 * database's uniqueness constraint, so a second acceptance fails here even if
 * two processes raced past the in-memory check.
 *
 * Enabled only when `SANAD_DATABASE_URL` is set.
 */

import type { Pool } from 'pg';

import type { CheckoutSession } from '@sanad/core/checkout/session.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { decodeJson, encodeJson } from '@sanad/origination/codec.ts';
import { sharedPool, tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { type Scoped, inTenant } from '@sanad/origination/tenant-scope.ts';

import type { Acceptance, StoredOffer } from './store.ts';

export interface IdempotencyRecord {
  readonly merchantId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
}

export interface ConsumerBook {
  readonly offers: readonly StoredOffer[];
  readonly acceptances: readonly Acceptance[];
  readonly sessions: readonly CheckoutSession[];
  readonly idempotency: readonly IdempotencyRecord[];
}

export function persistenceUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const url = env['SANAD_DATABASE_URL'];
  return url === undefined || url.trim().length === 0 ? undefined : url.trim();
}

export function persistencePool(env: Readonly<Record<string, string | undefined>> = process.env): Pool | undefined {
  const url = persistenceUrl(env);
  return url === undefined ? undefined : sharedPool(url);
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export async function loadConsumerBook(pool: Pool, tenantCode: string): Promise<ConsumerBook> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  return inTenant(pool, tenant, (db) => readConsumerBook(db, tenant));
}

async function readConsumerBook(db: Scoped, tenant: string): Promise<ConsumerBook> {
  const offers = await db.query<{ body: unknown }>(
    'select body from core.offer where tenant_id = $1::uuid order by sequence asc',
    [tenant],
  );
  const acceptances = await db.query<{
    acceptance_id: string;
    offer_id: string;
    disclosure_version: string;
    identity_assertion_id: string;
    locale_shown: 'ar-SA' | 'en-SA';
    accepted_at_epoch: string;
    accepted_tsa_digest: string;
    accepted_tsa_authority: string;
  }>(
    `select acceptance_id, offer_id, disclosure_version, identity_assertion_id, locale_shown,
            accepted_at_epoch::text, accepted_tsa_digest, accepted_tsa_authority
       from core.offer_acceptance where tenant_id = $1::uuid order by created_at asc`,
    [tenant],
  );
  const sessions = await db.query<{ session: unknown }>(
    'select session from core.checkout_session where tenant_id = $1::uuid order by sequence asc',
    [tenant],
  );
  const idempotency = await db.query<{ merchant_id: string; idempotency_key: string; session_id: string }>(
    'select merchant_id, idempotency_key, session_id from core.checkout_idempotency where tenant_id = $1::uuid',
    [tenant],
  );
  return {
    offers: offers.rows.map((r) => decodeJson(asText(r.body)) as StoredOffer),
    acceptances: acceptances.rows.map((r) => ({
      acceptanceId: r.acceptance_id,
      offerId: r.offer_id,
      disclosureVersion: r.disclosure_version,
      identityAssertionId: r.identity_assertion_id,
      localeShown: r.locale_shown,
      // Rebuilt through the one function allowed to establish an attested instant.
      acceptedAt: tsaInstant({
        verified: true,
        genTimeEpochSeconds: BigInt(r.accepted_at_epoch),
        tokenDigest: r.accepted_tsa_digest,
        authorityId: r.accepted_tsa_authority,
      }),
    })),
    sessions: sessions.rows.map((r) => decodeJson(asText(r.session)) as CheckoutSession),
    idempotency: idempotency.rows.map((r) => ({
      merchantId: r.merchant_id,
      idempotencyKey: r.idempotency_key,
      sessionId: r.session_id,
    })),
  };
}

/**
 * One transaction for everything changed: offers before the acceptances and
 * sessions that refer to them, sessions before the idempotency keys that
 * refer to those. Either the whole change is durable or none of it is.
 */
export async function saveConsumerBook(pool: Pool, tenantCode: string, changed: ConsumerBook): Promise<void> {
  if (changed.offers.length + changed.acceptances.length + changed.sessions.length + changed.idempotency.length === 0)
    return;
  const tenant = await tenantUuidByCode(pool, tenantCode);
  await inTenant(pool, tenant, async (client) => {
    for (const o of changed.offers) {
      await client.query(
        `insert into core.offer (tenant_id, offer_id, applicant_ref, product_code, body, disclosure_version, expires_at_epoch, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::bigint, $8, $9)
         on conflict (tenant_id, offer_id) do nothing`,
        [
          tenant,
          o.offerId,
          o.applicantRef,
          o.productCode,
          encodeJson(o),
          o.offer.disclosureVersion,
          o.expiresAtEpochSeconds.toString(),
          o.offerId,
          o.applicantRef,
        ],
      );
    }
    for (const a of changed.acceptances) {
      // No `on conflict` for the offer: a second acceptance of one offer must fail loudly.
      await client.query(
        `insert into core.offer_acceptance
           (tenant_id, acceptance_id, offer_id, disclosure_version, identity_assertion_id, locale_shown,
            accepted_at_epoch, accepted_tsa_digest, accepted_tsa_authority, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5, $6, $7::bigint, $8, $9, $10, $11)
         on conflict (tenant_id, acceptance_id) do nothing`,
        [
          tenant,
          a.acceptanceId,
          a.offerId,
          a.disclosureVersion,
          a.identityAssertionId,
          a.localeShown,
          a.acceptedAt.epochSeconds.toString(),
          a.acceptedAt.tokenDigest,
          a.acceptedAt.authorityId,
          a.acceptanceId,
          a.identityAssertionId,
        ],
      );
    }
    for (const s of changed.sessions) {
      await client.query(
        `insert into core.checkout_session (tenant_id, session_id, merchant_id, state, session, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)
         on conflict (tenant_id, session_id) do update
           set state = excluded.state, session = excluded.session, updated_at = now()`,
        [tenant, s.core.sessionId, s.core.merchantId, s.state, encodeJson(s), s.core.correlationId, s.core.merchantId],
      );
    }
    for (const i of changed.idempotency) {
      await client.query(
        `insert into core.checkout_idempotency (tenant_id, merchant_id, idempotency_key, session_id, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5, $6)
         on conflict (tenant_id, merchant_id, idempotency_key) do nothing`,
        [tenant, i.merchantId, i.idempotencyKey, i.sessionId, i.sessionId, i.merchantId],
      );
    }
  });
}
