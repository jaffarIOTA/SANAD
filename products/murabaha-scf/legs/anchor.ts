/**
 * Anchoring the leg chain outside ourselves (SR-008).
 *
 * `verifyChain` proves the legs agree with each other. It cannot prove they
 * are the legs that were executed: whoever can write the table can rebuild a
 * whole chain with fresh, consistent hashes. What they cannot rebuild is a
 * third party's signature. So each leg's RFC 3161 token is stamped over the
 * leg's anchor digest, which binds the leg's own content *and* its
 * predecessor's hash, its place in the sequence and its transaction. The head
 * leg's token therefore attests the whole chain up to it.
 *
 * A rebuilt chain fails here: its anchor digests differ, so the retained
 * tokens do not verify against them; and a token obtained afresh for a
 * rebuilt leg carries today's genTime from the authority, not the instant the
 * leg claims to have been executed.
 *
 * No clock is read. The authority's verification is a port.
 */

import { createHash } from 'node:crypto';

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { TimestampAuthorityPort } from '@sanad/core/time/tsa.ts';

import { type ContractLeg, verifyChain } from './leg.ts';

/**
 * The digest a leg's timestamp token is stamped over. Versioned, so the binding can evolve without ambiguity.
 * It names no instant: the token stamped over it is where the leg's instant comes from.
 */
export function legAnchorDigest(
  leg: Pick<
    ContractLeg,
    'tenantId' | 'transactionId' | 'sequenceNo' | 'legType' | 'documentId' | 'contentHash' | 'prevLegHash'
  >,
): string {
  const fields = [
    'sanad-leg-anchor-v1',
    leg.tenantId,
    leg.transactionId,
    String(leg.sequenceNo),
    leg.legType,
    leg.documentId,
    leg.contentHash,
    leg.prevLegHash ?? '',
  ];
  return createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex');
}

/** The retained token of a leg, as stored beside it; undefined when it is missing. */
export type RetainedToken = (leg: ContractLeg) => Promise<Uint8Array | undefined>;

/**
 * Verify the chain and every leg's anchor: the token verifies at the authority
 * over this leg's anchor digest, is the token the leg records, and attests the
 * instant and authority the leg records.
 */
export async function verifyAnchoredChain(
  chain: readonly ContractLeg[],
  retainedToken: RetainedToken,
  authority: Pick<TimestampAuthorityPort, 'verify'>,
): Promise<Result<true>> {
  const structural = verifyChain(chain);
  if (!structural.ok) return structural;
  for (const leg of chain) {
    const token = await retainedToken(leg);
    if (token === undefined)
      return reject('OP-CHAIN', 'ANCHOR_MISSING', 'The leg has no retained timestamp token', { legId: leg.legId });
    const attested = await authority.verify(token, legAnchorDigest(leg));
    if (attested === undefined)
      return reject('OP-CHAIN', 'ANCHOR_INVALID', 'The timestamp token does not attest this leg', { legId: leg.legId });
    if (
      attested.tokenDigest !== leg.tsaTokenDigest ||
      attested.tokenDigest !== leg.executedAt.tokenDigest ||
      attested.genTimeEpochSeconds !== leg.executedAt.epochSeconds ||
      attested.authorityId !== leg.executedAt.authorityId
    )
      return reject(
        'OP-CHAIN',
        'ANCHOR_MISMATCH',
        'The timestamp token attests a different token, instant or authority than the leg records',
        { legId: leg.legId },
      );
  }
  return ok(true);
}
