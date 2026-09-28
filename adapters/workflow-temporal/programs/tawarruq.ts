/**
 * The Tawarruq sequence as a program over effects. Same discipline as the
 * Murabaha program: orchestration only, types only from the domain, every
 * step an effect the host supplies. The broker's confirmations arrive as
 * signals; each transition is the one domain function for that step.
 */

export interface TawarruqEffects {
  purchaseCommodity(): Promise<void>;
  sellToCustomer(): Promise<void>;
  transferTitle(): Promise<void>;
  realiseProceeds(): Promise<void>;
  disburse(): Promise<void>;
  /** The customer's signature on the deferred sale, by reference. Resolved by a signal. */
  waitForSaleSignature(timeoutSeconds: number): Promise<'SIGNED' | 'TIMED_OUT'>;
  unwind(reason: string): Promise<void>;
  progress(step: string): void;
}

export interface TawarruqSequenceInput {
  readonly tenantId: string;
  readonly transactionId: string;
  readonly signatureTimeoutSeconds: number;
}

export type TawarruqOutcome = 'DISBURSED' | 'UNWOUND';

export async function runTawarruqSequence(fx: TawarruqEffects, input: TawarruqSequenceInput): Promise<TawarruqOutcome> {
  fx.progress('PURCHASING_COMMODITY');
  await fx.purchaseCommodity();
  fx.progress('AWAITING_SALE_SIGNATURE');
  const signed = await fx.waitForSaleSignature(input.signatureTimeoutSeconds);
  if (signed === 'TIMED_OUT') {
    fx.progress('UNWINDING');
    await fx.unwind('SALE_NOT_SIGNED');
    return 'UNWOUND';
  }
  fx.progress('SOLD_TO_CUSTOMER');
  await fx.sellToCustomer();
  fx.progress('TITLE_TRANSFERRED');
  await fx.transferTitle();
  fx.progress('PROCEEDS_REALISED');
  await fx.realiseProceeds();
  fx.progress('DISBURSED');
  await fx.disburse();
  return 'DISBURSED';
}
