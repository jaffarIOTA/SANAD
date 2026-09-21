/**
 * The financed invoice registry.
 *
 * Small, simple, and among the most important things in the system. Every
 * invoice the institution finances is registered permanently. A second attempt
 * against the same identifier is refused — and refused by a unique constraint in
 * the database, not by an application check that a race could slip past
 * (SH-10, SDD §5.4.4).
 *
 * This is a Shariah control before it is a credit control: financing the same
 * goods twice means selling what was not owned.
 *
 * Records are never purged. Not after settlement, not when the transaction ages
 * out of its retention window. The registry keeps the minimum identifiers needed
 * to prevent duplicate financing and nothing else, which is what makes indefinite
 * retention proportionate under PDPL.
 */

import type { Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export interface FinancedInvoiceRecord {
  readonly tenantId: string;
  /** Unique identifier issued by the e-invoicing authority. */
  readonly invoiceUuid: string;
  readonly invoiceHash: string;
  readonly issuerCr: string;
  readonly recipientCr: string;
  readonly financedAmount: Money;
  readonly transactionId: string;
  readonly financedAtEpochSeconds: bigint;
}

/**
 * Port. The adapter is a repository over the table whose unique constraint is
 * the actual enforcement.
 *
 * Note the absence of a `delete`, an `archive` and an upsert. There is no
 * `ON CONFLICT DO NOTHING` here or in the migration: a conflict is the control
 * firing, and swallowing it would defeat the whole mechanism.
 */
export interface FinancedInvoiceRegistryPort {
  /**
   * Insert. Rejects with SH-10 where the identifier is already registered for
   * this tenant. Idempotent only on the same transaction id — a replay of the
   * same drawdown succeeds; a different drawdown against the same invoice does
   * not.
   */
  register(record: FinancedInvoiceRecord): Promise<Result<{ readonly registryId: string }>>;

  lookup(
    tenantId: string,
    invoiceUuid: string,
  ): Promise<{ readonly transactionId: string } | undefined>;
}

/**
 * The pre-flight check, run during trade validation so the counterparty gets a
 * specific answer rather than a failed insert. It does not replace the
 * constraint; it improves the message.
 */
export async function assertNotPreviouslyFinanced(
  registry: FinancedInvoiceRegistryPort,
  tenantId: string,
  invoiceUuid: string,
): Promise<Result<true>> {
  const existing = await registry.lookup(tenantId, invoiceUuid);
  if (existing !== undefined) {
    return reject(
      'SH-10',
      'DUPLICATE_FINANCING',
      'This invoice has already been financed and cannot be financed again',
      { existingReference: existing.transactionId },
    );
  }
  return ok(true);
}
