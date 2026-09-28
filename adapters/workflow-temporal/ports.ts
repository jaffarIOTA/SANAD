/**
 * What the activities need from the host. Ports, so the worker is assembled
 * from the same adapters the services use and the in-memory runner from
 * stores that live in a Map.
 */

import type { EvidenceRecord } from '../../core/evidence/evidence.ts';
import type { Result } from '../../core/kernel/result.ts';
import type { TsaInstant } from '../../core/time/tsa.ts';
import type { ContractLeg, LegType } from '../../products/murabaha-scf/legs/leg.ts';
import type { Transaction } from '../../products/murabaha-scf/sequencing/state.ts';
import type { StructureDefinition } from '../../products/murabaha-scf/structures/definition.ts';
import type { TawarruqTransaction } from '../../products/tawarruq-personal/execution.ts';

export interface TransactionStore {
  load(tenantId: string, transactionId: string): Promise<Transaction | undefined>;
  save(transaction: Transaction): Promise<void>;
}

export interface TawarruqStore {
  load(tenantId: string, transactionId: string): Promise<TawarruqTransaction | undefined>;
  save(transaction: TawarruqTransaction): Promise<void>;
}

export interface EvidenceStore {
  forTransaction(tenantId: string, transactionId: string): Promise<readonly EvidenceRecord[]>;
}

export interface StructureSource {
  definition(tenantId: string, definitionId: string): Promise<Result<StructureDefinition>>;
}

/** The document pipeline for one leg: render against the approved template, sign, timestamp, chain. */
export interface LegPreparer {
  prepare(params: {
    readonly transaction: Transaction;
    readonly legType: LegType;
    readonly sequenceNo: number;
    readonly previousContentHash?: string;
    /** The template slug from the structure definition; the pipeline resolves it to an approved version. */
    readonly document: string;
  }): Promise<Result<ContractLeg>>;
}

export interface Attestation {
  /** An attested instant for an act happening now — from the timestamping authority, never a clock. */
  attest(): Promise<TsaInstant>;
}

export interface SequencingPorts {
  readonly transactions: TransactionStore;
  readonly evidence: EvidenceStore;
  readonly structures: StructureSource;
  readonly legs: LegPreparer;
  readonly attestation: Attestation;
}
