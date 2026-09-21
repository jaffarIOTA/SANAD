/**
 * Result and control-coded rejection.
 *
 * Every refusal in the domain names the control that produced it (SH-05, SH-10, …).
 * A generic decline is not acceptable: the control code is what the Shariah audit
 * workspace renders, what the API returns in the RFC 9457 problem detail, and what
 * the counterparty surface turns into a specific Arabic explanation.
 */

/** Shariah controls, as enumerated in SDD §2.9. */
export type ShariahControl =
  | 'SH-01' // no riba — return is a profit amount, never a rate
  | 'SH-02' // no riba on default — an executed total never increases
  | 'SH-03' // no gharar — determinacy before execution
  | 'SH-04' // no maysir — no contingent pricing or optionality
  | 'SH-05' // no sale before ownership
  | 'SH-06' // genuine ownership risk — the risk-holding interval
  | 'SH-07' // separation of contracts — one leg, one document
  | 'SH-08' // no 'inah — counterparty distinctness
  | 'SH-09' // no sale of debt
  | 'SH-10' // no duplicate financing
  | 'SH-11' // permissible goods only
  | 'SH-12' // permissible counterparty activity
  | 'SH-13' // late charges are not income
  | 'SH-14' // forbearance for genuine hardship
  | 'SH-15' // disclosure of cost and profit
  | 'SH-16' // takaful only
  | 'SH-17' // fatwa-bound operation
  | 'SH-18'; // auditability by the Board

/** Non-Shariah refusals that still need a stable machine code. */
export type OperationalControl =
  | 'OP-DETERMINACY' // a required value is absent or indeterminate
  | 'OP-CHAIN' // hash chain or timestamp monotonicity broken
  | 'OP-LIMIT'; // limit or concentration breach

export type ControlCode = ShariahControl | OperationalControl;

export interface Rejection {
  readonly control: ControlCode;
  /** Machine-readable reason, e.g. 'GATE_3_RISK_PERIOD_NOT_ELAPSED'. */
  readonly reason: string;
  /** English text. The Arabic rendering is resolved from `reason` at the edge. */
  readonly detail: string;
  /** Structured context for the audit trail. Never carries personal data. */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export type Result<T, E = Rejection> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function reject(
  control: ControlCode,
  reason: string,
  detail: string,
  context?: Readonly<Record<string, string | number | boolean>>,
): Result<never, Rejection> {
  return err(context === undefined ? { control, reason, detail } : { control, reason, detail, context });
}

/** Narrowing helpers, so call sites read as prose. */
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

/** Unwrap for tests and for call sites that have already checked. Throws otherwise. */
export function expectOk<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`expected ok, got rejection: ${JSON.stringify(r.error)}`);
}
