/**
 * Fixed-point arithmetic at 10^18, for the few places pricing needs a power
 * or a logarithm: APR (core/pricing/apr.ts) and an annuity factor
 * (core/pricing/schedule.ts). Everything is `bigint`; nothing here is a float.
 */

export const SCALE = 10n ** 18n;
export const ONE = SCALE;

/** ln 2 at 10^18. A constant, not a computation the series would have to converge on. */
export const LN2 = 693_147_180_559_945_309n;

export function mul(a: bigint, b: bigint): bigint {
  const p = a * b;
  return p >= 0n ? (p + SCALE / 2n) / SCALE : -((-p + SCALE / 2n) / SCALE);
}

export function div(a: bigint, b: bigint): bigint {
  const n = a * SCALE;
  return n >= 0n === b >= 0n ? (n + b / 2n) / b : -((-n + b / 2n) / b);
}

/** ln(y) for y > 0, via 2·atanh((y−1)/(y+1)) after scaling y into [0.5, 2). */
export function ln(y: bigint): bigint {
  if (y <= 0n) throw new RangeError('ln of non-positive');
  let k = 0n;
  let v = y;
  while (v >= 2n * ONE) { v /= 2n; k += 1n; }
  while (v < ONE / 2n) { v *= 2n; k -= 1n; }
  const z = div(v - ONE, v + ONE);
  const z2 = mul(z, z);
  let term = z;
  let sum = 0n;
  for (let n = 1n; n < 200n; n += 2n) {
    const contribution = term / n;
    if (contribution === 0n) break;
    sum += contribution;
    term = mul(term, z2);
  }
  return 2n * sum + k * LN2;
}

/** exp(z) by argument halving and a Taylor series. */
export function exp(z: bigint): bigint {
  let halvings = 0n;
  let v = z;
  const limit = ONE / 8n;
  while (v > limit || v < -limit) { v /= 2n; halvings += 1n; }
  let term = ONE;
  let sum = ONE;
  for (let n = 1n; n < 60n; n += 1n) {
    term = mul(term, v) / n;
    if (term === 0n) break;
    sum += term;
  }
  for (let i = 0n; i < halvings; i += 1n) sum = mul(sum, sum);
  return sum;
}

/** base^exponent for base > 0, both fixed point. */
export function pow(base: bigint, exponent: bigint): bigint {
  return exp(mul(exponent, ln(base)));
}

/** (1 + x)^n for an integer n by repeated squaring — exact where the series is not. */
export function powInt(base: bigint, n: bigint): bigint {
  let result = ONE;
  let b = base;
  let e = n;
  while (e > 0n) {
    if (e & 1n) result = mul(result, b);
    b = mul(b, b);
    e >>= 1n;
  }
  return result;
}
