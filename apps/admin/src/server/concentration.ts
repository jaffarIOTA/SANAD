/**
 * The Concentration area (Wasl W5a): which concentration rules the
 * institution applies to a trade before its cost is held, and their values.
 * A change is the whole policy, parsed by the production parser before it may
 * be proposed, and takes effect only when a different administrator approves
 * it. Amounts are entered in riyals and shares in percent, and converted here
 * in whole numbers — never through floating point.
 */

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import {
  type ConcentrationPolicy,
  concentrationPolicyToJson,
  parseConcentrationPolicy,
} from '@sanad/products/murabaha-scf/limits/drawdown-limits.ts';

export { resolveConcentrationWithSource } from '@sanad/origination/wasl/concentration.ts';

export interface ConcentrationForm {
  readonly policyRef: string;
  readonly tradeCapEnabled: boolean;
  /** Whole riyals. */
  readonly tradeCapRiyals: string;
  readonly distributorShareEnabled: boolean;
  /** Percent, up to two decimals: "25" or "12.5". */
  readonly distributorSharePercent: string;
  readonly anchorShareEnabled: boolean;
  readonly anchorSharePercent: string;
}

/** "12.5" → 1250 per ten thousand, in integers. Undefined when it is not a percentage with at most two decimals. */
export function perTenThousand(percent: string): number | undefined {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent.trim());
  if (m === null) return undefined;
  const whole = Number(m[1]);
  const fraction = Number((m[2] ?? '').padEnd(2, '0'));
  const v = whole * 100 + fraction;
  return v >= 1 && v <= 10_000 ? v : undefined;
}

/** 1250 → "12.5": the percentage as the form shows it back. */
export const percentOf = (n: number): string =>
  n % 100 === 0
    ? String(n / 100)
    : `${String(Math.floor(n / 100))}.${String(n % 100)
        .padStart(2, '0')
        .replace(/0$/, '')}`;

/** The proposed policy from the form, checked by the production parser. */
export function policyFromForm(
  f: ConcentrationForm,
): Result<{ readonly payload: unknown; readonly parsed: ConcentrationPolicy }> {
  const bad = (reason: string) => reject('OP-DETERMINACY', reason, 'The concentration policy is not complete');
  const riyals = f.tradeCapRiyals.replace(/[^\d]/g, '');
  if (f.tradeCapEnabled && !/^\d{1,13}$/.test(riyals)) return bad('TRADE_CAP_REQUIRED');
  const distributor = perTenThousand(f.distributorSharePercent || '100');
  if (distributor === undefined) return bad('DISTRIBUTOR_SHARE_MALFORMED');
  const anchor = perTenThousand(f.anchorSharePercent || '100');
  if (anchor === undefined) return bad('ANCHOR_SHARE_MALFORMED');
  const payload = {
    policyRef: f.policyRef.trim(),
    singleTradeCap: {
      enabled: f.tradeCapEnabled,
      maxCostMinorUnits: riyals === '' ? '0' : (BigInt(riyals) * 100n).toString(),
    },
    distributorShareOfProgramme: { enabled: f.distributorShareEnabled, maxSharePerTenThousand: distributor },
    anchorShareOfBook: { enabled: f.anchorShareEnabled, maxSharePerTenThousand: anchor },
  };
  const parsed = parseConcentrationPolicy(payload);
  if (!parsed.ok) return parsed;
  return ok({ payload: concentrationPolicyToJson(parsed.value), parsed: parsed.value });
}
