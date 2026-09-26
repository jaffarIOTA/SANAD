/**
 * What a Murabaha approval actually buys: a transaction at the **start** of
 * the sequence, and nothing later.
 *
 * This is the module's `execute()` entry. It takes the engine's `Approved`
 * request and returns a `Draft`; every later state is reachable only through
 * the transitions in `../sequencing/transitions.ts`, each of which accepts
 * its predecessor and nothing else.
 */

import type { Approved } from '@sanad/core/origination/request.ts';
import { type Result, reject, ok } from '@sanad/core/kernel/result.ts';

import type { Draft, TransactionCore } from '../sequencing/state.ts';

/**
 * Convert an approved request into a transaction at the **start** of the
 * sequence.
 *
 * Note the return type. `Draft` is the first state of the transaction state
 * machine; from here the only legal move is `submit`, and after that trade
 * validation, limit reservation, the wa'd, the purchase, ownership evidence,
 * possession evidence and the Board's risk-holding interval — in that order,
 * each enforced by a transition that only accepts its predecessor.
 *
 * There is no variant of this function that returns anything later, and no
 * parameter that says "skip to". A checker's signature authorises opening a
 * file, not executing a sale.
 */
export function openTransaction(
  request: Approved,
  core: TransactionCore,
): Result<Draft> {
  if (core.tenantId !== request.core.tenantId) {
    return reject(
      'OP-DETERMINACY',
      'TENANT_MISMATCH',
      'The transaction and the request it came from must belong to one tenant',
      { requestId: request.core.requestId },
    );
  }
  if (core.counterpartyId !== request.core.counterpartyId) {
    return reject(
      'OP-DETERMINACY',
      'COUNTERPARTY_MISMATCH',
      'The transaction must be for the counterparty the request named',
      { requestId: request.core.requestId },
    );
  }
  if (core.tradeReference.invoiceUuid !== request.core.tradeReference.invoiceUuid) {
    return reject(
      'SH-10',
      'TRADE_REFERENCE_SUBSTITUTED',
      'The trade on the transaction is not the trade that was approved',
      { requestId: request.core.requestId },
    );
  }

  return ok({ state: 'DRAFT', core });
}
