/**
 * The financed invoice registry on PostgreSQL (`core.financed_invoice_registry`,
 * migration 0003; SH-10, SR-013).
 *
 * A plain INSERT. No upsert, no ON CONFLICT: the table's unique constraint on
 * (tenant, invoice) is the control, and a conflict is the control firing. Two
 * concurrent drawdowns against one invoice both reach the constraint; exactly
 * one commits. The loser is told SH-10, unless it is a replay of the very same
 * drawdown, which is answered with the existing registration.
 */

import type { Pool } from 'pg';

import { ok, reject, type Result } from '../../../core/kernel/result.ts';
import type {
  FinancedInvoiceRecord,
  FinancedInvoiceRegistryPort,
} from '../../../products/murabaha-scf/trade/financed-invoice-registry.ts';

import { inTenant } from './tenant-scope.ts';

const UNIQUE_VIOLATION = '23505';

const isRegistryConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: string }).code === UNIQUE_VIOLATION &&
  (error as { constraint?: string }).constraint === 'financed_invoice_unique';

export function postgresFinancedInvoiceRegistry(pool: Pool): FinancedInvoiceRegistryPort {
  const lookup = async (tenantId: string, invoiceUuid: string) => {
    const { rows } = await inTenant(pool, tenantId, (db) =>
      db.query<{ id: string; transaction_id: string }>(
        'select id::text, transaction_id::text from core.financed_invoice_registry where tenant_id = $1 and invoice_uuid = $2',
        [tenantId, invoiceUuid],
      ),
    );
    return rows[0];
  };

  return {
    async register(record: FinancedInvoiceRecord): Promise<Result<{ readonly registryId: string }>> {
      try {
        const { rows } = await inTenant(pool, record.tenantId, (db) =>
          db.query<{ id: string }>(
            `insert into core.financed_invoice_registry
               (tenant_id, invoice_uuid, invoice_hash, issuer_cr, recipient_cr, financed_amount_minor, currency,
                transaction_id, financed_at, correlation_id)
             values ($1, $2, $3, $4, $5, $6::bigint, $7, $8, to_timestamp($9::bigint), $8)
             returning id::text`,
            [
              record.tenantId,
              record.invoiceUuid,
              record.invoiceHash,
              record.issuerCr,
              record.recipientCr,
              record.financedAmount.minorUnits.toString(),
              record.financedAmount.currency,
              record.transactionId,
              record.financedAtEpochSeconds.toString(),
            ],
          ),
        );
        return ok({ registryId: rows[0]?.id as string });
      } catch (error) {
        if (!isRegistryConflict(error)) throw error;
        // The constraint fired. The same drawdown replayed is answered with what it already registered.
        const existing = await lookup(record.tenantId, record.invoiceUuid);
        if (existing !== undefined && existing.transaction_id === record.transactionId)
          return ok({ registryId: existing.id });
        return reject(
          'SH-10',
          'DUPLICATE_FINANCING',
          'This invoice has already been financed and cannot be financed again',
          {
            ...(existing === undefined ? {} : { existingReference: existing.transaction_id }),
          },
        );
      }
    },

    async lookup(tenantId, invoiceUuid) {
      const existing = await lookup(tenantId, invoiceUuid);
      return existing === undefined ? undefined : { transactionId: existing.transaction_id };
    },
  };
}
