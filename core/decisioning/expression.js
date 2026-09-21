import { ok, reject } from "../kernel/result.js";
function evaluate(expr, ctx) {
  if ("const" in expr) return ok(expr.const);
  if ("constMoneyMinorUnits" in expr) {
    try {
      return ok(BigInt(expr.constMoneyMinorUnits));
    } catch {
      return reject("OP-DETERMINACY", "MALFORMED_MONEY_LITERAL", "Money literal is not an integer", {
        literal: expr.constMoneyMinorUnits
      });
    }
  }
  if (!("op" in expr)) {
    const value = ctx.resolve(expr.field);
    if (value === void 0) {
      return reject("OP-DETERMINACY", "UNKNOWN_POLICY_FIELD", "Policy references an unknown field", {
        field: expr.field
      });
    }
    return ok(value);
  }
  switch (expr.op) {
    case "exists":
      return ok(ctx.resolve(expr.field) !== void 0);
    case "not": {
      const inner = evaluate(expr.arg, ctx);
      if (!inner.ok) return inner;
      return ok(!truthy(inner.value));
    }
    case "and":
    case "or": {
      let acc = expr.op === "and";
      for (const arg of expr.args) {
        const v = evaluate(arg, ctx);
        if (!v.ok) return v;
        const b = truthy(v.value);
        if (expr.op === "and") {
          acc = acc && b;
          if (!acc) break;
        } else {
          acc = acc || b;
          if (acc) break;
        }
      }
      return ok(acc);
    }
    case "eq":
    case "ne": {
      const l = evaluate(expr.left, ctx);
      if (!l.ok) return l;
      const r = evaluate(expr.right, ctx);
      if (!r.ok) return r;
      const same = looseEquals(l.value, r.value);
      return ok(expr.op === "eq" ? same : !same);
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const l = evaluate(expr.left, ctx);
      if (!l.ok) return l;
      const r = evaluate(expr.right, ctx);
      if (!r.ok) return r;
      const cmp = compareNumeric(l.value, r.value);
      if (!cmp.ok) return cmp;
      const c = cmp.value;
      switch (expr.op) {
        case "lt":
          return ok(c < 0);
        case "lte":
          return ok(c <= 0);
        case "gt":
          return ok(c > 0);
        case "gte":
          return ok(c >= 0);
      }
    }
    case "in":
    case "notIn": {
      const l = evaluate(expr.left, ctx);
      if (!l.ok) return l;
      const present = expr.right.some((candidate) => looseEquals(l.value, candidate));
      return ok(expr.op === "in" ? present : !present);
    }
    case "add":
    case "sub":
    case "min":
    case "max": {
      const values = [];
      for (const arg of expr.args) {
        const v = evaluate(arg, ctx);
        if (!v.ok) return v;
        const n = asBigInt(v.value);
        if (!n.ok) return n;
        values.push(n.value);
      }
      const first = values[0];
      if (first === void 0) {
        return reject("OP-DETERMINACY", "ARITHMETIC_NO_OPERANDS", "Arithmetic requires operands", {
          op: expr.op
        });
      }
      let acc = first;
      for (const v of values.slice(1)) {
        if (expr.op === "add") acc += v;
        else if (expr.op === "sub") acc -= v;
        else if (expr.op === "min") acc = v < acc ? v : acc;
        else acc = v > acc ? v : acc;
      }
      return ok(acc);
    }
    case "scaleBasisPoints": {
      const v = evaluate(expr.arg, ctx);
      if (!v.ok) return v;
      const n = asBigInt(v.value);
      if (!n.ok) return n;
      if (!Number.isInteger(expr.basisPoints) || expr.basisPoints < 0) {
        return reject(
          "OP-DETERMINACY",
          "BASIS_POINTS_INVALID",
          "Basis points must be a non-negative whole number",
          { basisPoints: expr.basisPoints }
        );
      }
      return ok(n.value * BigInt(expr.basisPoints) / 10000n);
    }
  }
}
function evaluateCondition(expr, ctx) {
  const v = evaluate(expr, ctx);
  if (!v.ok) return v;
  if (typeof v.value !== "boolean") {
    return reject("OP-DETERMINACY", "CONDITION_NOT_BOOLEAN", "Condition did not evaluate to a boolean", {
      valueType: typeof v.value
    });
  }
  return ok(v.value);
}
function evaluateMoney(expr, ctx) {
  const v = evaluate(expr, ctx);
  if (!v.ok) return v;
  return asBigInt(v.value);
}
function truthy(v) {
  return v === true;
}
function looseEquals(a, b) {
  if (typeof a === "bigint" || typeof b === "bigint") {
    const an = asBigInt(a);
    const bn = asBigInt(b);
    return an.ok && bn.ok && an.value === bn.value;
  }
  return a === b;
}
function compareNumeric(a, b) {
  const an = asBigInt(a);
  if (!an.ok) return an;
  const bn = asBigInt(b);
  if (!bn.ok) return bn;
  if (an.value < bn.value) return ok(-1);
  if (an.value > bn.value) return ok(1);
  return ok(0);
}
function asBigInt(v) {
  if (typeof v === "bigint") return ok(v);
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      return reject(
        "OP-DETERMINACY",
        "NON_INTEGER_IN_FINANCIAL_PATH",
        "Policy arithmetic is integer only; express fractions as basis points",
        { value: v }
      );
    }
    return ok(BigInt(v));
  }
  return reject("OP-DETERMINACY", "VALUE_NOT_NUMERIC", "Expected a numeric value", {
    valueType: typeof v
  });
}
function pathResolver(root) {
  return (path) => {
    let current = root;
    for (const segment of path.split(".")) {
      if (current === null || typeof current !== "object") return void 0;
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return void 0;
      current = current[segment];
    }
    const t = typeof current;
    if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
      return current;
    }
    return void 0;
  };
}
function referencedFields(expr, into = /* @__PURE__ */ new Set()) {
  if ("const" in expr || "constMoneyMinorUnits" in expr) {
  } else if (!("op" in expr)) {
    into.add(expr.field);
  } else {
    switch (expr.op) {
      case "exists":
        into.add(expr.field);
        break;
      case "not":
        referencedFields(expr.arg, into);
        break;
      case "and":
      case "or":
      case "add":
      case "sub":
      case "min":
      case "max":
        for (const a of expr.args) referencedFields(a, into);
        break;
      case "eq":
      case "ne":
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        referencedFields(expr.left, into);
        referencedFields(expr.right, into);
        break;
      case "in":
      case "notIn":
        referencedFields(expr.left, into);
        break;
      case "scaleBasisPoints":
        referencedFields(expr.arg, into);
        break;
    }
  }
  return into;
}
export {
  evaluate,
  evaluateCondition,
  evaluateMoney,
  pathResolver,
  referencedFields
};
