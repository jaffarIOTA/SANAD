import { ok, reject } from "./result.js";
function money(minorUnits, currency = "SAR") {
  if (typeof minorUnits === "number") {
    if (!Number.isInteger(minorUnits)) {
      throw new TypeError(`money() requires whole minor units, received ${minorUnits}`);
    }
    return { minorUnits: BigInt(minorUnits), currency };
  }
  return { minorUnits, currency };
}
const zero = (currency = "SAR") => ({ minorUnits: 0n, currency });
const isNegative = (m) => m.minorUnits < 0n;
const isZero = (m) => m.minorUnits === 0n;
const isPositive = (m) => m.minorUnits > 0n;
const sameCurrency = (a, b) => a.currency === b.currency;
const equals = (a, b) => a.currency === b.currency && a.minorUnits === b.minorUnits;
function compare(a, b) {
  assertSameCurrency(a, b, "compare");
  if (a.minorUnits < b.minorUnits) return -1;
  if (a.minorUnits > b.minorUnits) return 1;
  return 0;
}
function add(a, b) {
  assertSameCurrency(a, b, "add");
  return { minorUnits: a.minorUnits + b.minorUnits, currency: a.currency };
}
function subtract(a, b) {
  assertSameCurrency(a, b, "subtract");
  return { minorUnits: a.minorUnits - b.minorUnits, currency: a.currency };
}
function sum(amounts, currency = "SAR") {
  let total = 0n;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new TypeError(`sum() mixed currencies: expected ${currency}, found ${amount.currency}`);
    }
    total += amount.minorUnits;
  }
  return { minorUnits: total, currency };
}
function requireDeterminate(amount, field) {
  if (amount === void 0) {
    return reject("SH-03", "AMOUNT_INDETERMINATE", `${field} must be determinate before execution`, {
      field
    });
  }
  if (isNegative(amount)) {
    return reject("SH-03", "AMOUNT_NEGATIVE", `${field} must not be negative`, { field });
  }
  return ok(amount);
}
function assertSameCurrency(a, b, op) {
  if (a.currency !== b.currency) {
    throw new TypeError(`money.${op}() across currencies: ${a.currency} and ${b.currency}`);
  }
}
export {
  add,
  compare,
  equals,
  isNegative,
  isPositive,
  isZero,
  money,
  requireDeterminate,
  sameCurrency,
  subtract,
  sum,
  zero
};
