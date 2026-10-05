/**
 * The consumer journey's records on PostgreSQL (migration 0011). What is
 * saved is what is loaded; an offer and an acceptance cannot be changed once
 * written; an offer is accepted once, and the database is what refuses the
 * second. Runs only when SANAD_TEST_DATABASE_URL is set.
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { create } from '@sanad/core/checkout/session.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

import { quoteFor } from '../../apps/consumer/src/server/engine.ts';
import { loadConsumerBook, saveConsumerBook } from '../../apps/consumer/src/server/persistence.ts';
import type { Acceptance, StoredOffer } from '../../apps/consumer/src/server/store.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_791_600_000;
const RUN = String(Date.now());
const TENANT = 'fintech-b';
const EMPTY = { offers: [], acceptances: [], sessions: [], idempotency: [] };

describe.skipIf(url === undefined)('the consumer journey on PostgreSQL (SANAD_TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const offerId = `ofr_contract_${RUN}`;
  const quoted = expectOk(quoteFor('tawarruq-personal', 5_000_000n, 12, 'app-contract', at(T0)));
  const offer: StoredOffer = { offerId, tenantId: TENANT, applicantRef: 'app-contract', productCode: 'tawarruq-personal', offer: quoted.offer, maturityDateGregorian: '2027-10-05', maturityDateHijri: '1449-05-04', expiresAtEpochSeconds: BigInt(T0) + 604_800n };
  const acceptance: Acceptance = { acceptanceId: `acc_contract_${RUN}`, offerId, disclosureVersion: quoted.offer.disclosureVersion, identityAssertionId: 'asr-contract', localeShown: 'ar-SA', acceptedAt: at(T0 + 30) };
  const session = expectOk(create({ sessionId: `chk-contract-${RUN}`, tenantId: TENANT, merchantId: 'mer-contract', merchantOrderRef: 'ORD-1', basket: money(120_000n), productCode: 'bnpl', returnUrl: 'https://shop.example/return', cancelUrl: 'https://shop.example/cancel', createdAt: at(T0), expiresAtEpochSeconds: BigInt(T0) + 1_800n, correlationId: `cor-${RUN}` }));

  afterAll(async () => { await pool.end(); });

  it('loads back the offer exactly as issued: figures, APR and both maturity dates', async () => {
    await saveConsumerBook(pool, TENANT, { ...EMPTY, offers: [offer] });
    const found = (await loadConsumerBook(pool, TENANT)).offers.find((o) => o.offerId === offerId);
    expect(found).toEqual(offer);
    expect(found?.offer.apr.computedBy).toBe('core/pricing/apr.ts');
    expect(typeof found?.offer.apr.bp).toBe('bigint');
  });

  it('an offer is a snapshot: the table refuses a change, and saving it again changes nothing', async () => {
    await expect(pool.query("update core.offer set product_code = 'bnpl' where offer_id = $1", [offerId])).rejects.toThrow(/append-only/);
    await saveConsumerBook(pool, TENANT, { ...EMPTY, offers: [{ ...offer, productCode: 'bnpl' }] });
    expect((await loadConsumerBook(pool, TENANT)).offers.find((o) => o.offerId === offerId)?.productCode).toBe('tawarruq-personal');
  });

  it('records the acceptance with the disclosure version shown and the attested instant, rebuilt as attested', async () => {
    await saveConsumerBook(pool, TENANT, { ...EMPTY, acceptances: [acceptance] });
    const found = (await loadConsumerBook(pool, TENANT)).acceptances.find((a) => a.acceptanceId === acceptance.acceptanceId);
    expect(found).toEqual(acceptance);
    expect(found?.acceptedAt.epochSeconds).toBe(BigInt(T0 + 30));
  });

  it('an offer is accepted once: the database refuses a second acceptance, whoever raced past the check', async () => {
    const second: Acceptance = { ...acceptance, acceptanceId: `acc_contract_second_${RUN}`, acceptedAt: at(T0 + 31) };
    await expect(saveConsumerBook(pool, TENANT, { ...EMPTY, acceptances: [second] })).rejects.toThrow(/offer_acceptance_once/);
    await expect(pool.query('delete from core.offer_acceptance where acceptance_id = $1', [acceptance.acceptanceId])).rejects.toThrow(/append-only/);
  });

  it('a checkout session follows its state, and the merchant’s idempotency key points at it', async () => {
    await saveConsumerBook(pool, TENANT, { ...EMPTY, sessions: [session], idempotency: [{ merchantId: 'mer-contract', idempotencyKey: `key-${RUN}`, sessionId: session.core.sessionId }] });
    const book = await loadConsumerBook(pool, TENANT);
    expect(book.sessions.find((s) => s.core.sessionId === session.core.sessionId)).toEqual(session);
    expect(book.idempotency.find((i) => i.idempotencyKey === `key-${RUN}`)?.sessionId).toBe(session.core.sessionId);
    const refused = { ...session, state: 'REFUSED' as const, control: 'OP-LIMIT', reason: 'BNPL_CONSUMER_LIMIT_EXCEEDED' };
    await saveConsumerBook(pool, TENANT, { ...EMPTY, sessions: [refused] });
    const rows = await pool.query<{ state: string }>('select state from core.checkout_session where session_id = $1', [session.core.sessionId]);
    expect(rows.rows).toEqual([{ state: 'REFUSED' }]);
  });

  it('a book belongs to its tenant', async () => {
    expect((await loadConsumerBook(pool, 'bank-a')).offers.some((o) => o.offerId === offerId)).toBe(false);
  });
});
