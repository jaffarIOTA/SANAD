/**
 * The policy expression language.
 *
 * Credit policy is authored and approved outside the release cycle (BR-C08), so
 * it has to be data. But data that decides who gets credit needs to be
 * inspectable, deterministic and total — an institution's Credit function has to
 * be able to read a rule, and an auditor has to be able to re-run it. So instead
 * of embedding a general scripting language, this is a small closed set of
 * operators over a typed snapshot.
 *
 * Deliberately absent: loops, function definitions, regular expressions, string
 * concatenation, date arithmetic and anything that could read the clock. Every
 * expression terminates, every evaluation is pure, and the only inputs are the
 * snapshot fields the policy names.
 *
 * Money is `bigint` minor units throughout. Where a policy needs to scale an
 * amount — three months of trade, fifteen per cent of a programme limit — it
 * does so in basis points with integer arithmetic that rounds down, because a
 * limit that rounds up is a limit someone did not approve.
 */

import { type Result, ok, reject } from '../kernel/result.ts';

export type PolicyValue = string | number | boolean | bigint;

export type Expr =
  /** A literal. Money literals use `constMoneyMinorUnits` to stay exact. */
  | { readonly const: string | number | boolean }
  | { readonly constMoneyMinorUnits: string }
  /** A dotted path into the snapshot, e.g. `tradeHistory.withAnchor.monthsTrading`. */
  | { readonly field: string }
  | { readonly op: 'and' | 'or'; readonly args: readonly Expr[] }
  | { readonly op: 'not'; readonly arg: Expr }
  | { readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; readonly left: Expr; readonly right: Expr }
  | { readonly op: 'in' | 'notIn'; readonly left: Expr; readonly right: readonly (string | number)[] }
  /** True when the named path resolves to something other than undefined. */
  | { readonly op: 'exists'; readonly field: string }
  /** Integer/bigint arithmetic for limit sizing. */
  | { readonly op: 'add' | 'sub' | 'min' | 'max'; readonly args: readonly Expr[] }
  /** Scale by basis points; 10000 = 1x. Rounds toward zero. */
  | { readonly op: 'scaleBasisPoints'; readonly arg: Expr; readonly basisPoints: number };

export interface EvaluationContext {
  /** The snapshot, read through a path resolver. */
  readonly resolve: (path: string) => PolicyValue | undefined;
}

/**
 * Evaluate an expression. Returns a rejection rather than throwing, so a
 * malformed policy surfaces as a refusal to decide — which routes the
 * application to manual review — rather than as an exception that might be
 * caught and turned into a silent decline.
 */
export function evaluate(expr: Expr, ctx: EvaluationContext): Result<PolicyValue> {
  if ('const' in expr) return ok(expr.const);

  if ('constMoneyMinorUnits' in expr) {
    try {
      return ok(BigInt(expr.constMoneyMinorUnits));
    } catch {
      return reject('OP-DETERMINACY', 'MALFORMED_MONEY_LITERAL', 'Money literal is not an integer', {
        literal: expr.constMoneyMinorUnits,
      });
    }
  }

  if (!('op' in expr)) {
    const value = ctx.resolve(expr.field);
    if (value === undefined) {
      return reject('OP-DETERMINACY', 'UNKNOWN_POLICY_FIELD', 'Policy references an unknown field', {
        field: expr.field,
      });
    }
    return ok(value);
  }

  switch (expr.op) {
    case 'exists':
      return ok(ctx.resolve(expr.field) !== undefined);

    case 'not': {
      const inner = evaluate(expr.arg, ctx);
      if (!inner.ok) return inner;
      return ok(!truthy(inner.value));
    }

    case 'and':
    case 'or': {
      // Short-circuits, but every branch is still a pure expression.
      let acc = expr.op === 'and';
      for (const arg of expr.args) {
        const v = evaluate(arg, ctx);
        if (!v.ok) return v;
        const b = truthy(v.value);
        if (expr.op === 'and') {
          acc = acc && b;
          if (!acc) break;
        } else {
          acc = acc || b;
          if (acc) break;
        }
      }
      return ok(acc);
    }

    case 'eq':
    case 'ne': {
      const l = evaluate(expr.left, ctx);
      if (!l.ok) return l;
      const r = evaluate(expr.right, ctx);
      if (!r.ok) return r;
      const same = looseEquals(l.value, r.value);
      return ok(expr.op === 'eq' ? same : !same);
    }

    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const l = evaluate(expr.left, ctx);
      if (!l.ok) return l;
      const r = evaluate(expr.right, ctx);
      if (!r.ok) return r;
      const cmp = compareNumeric(l.value, r.value);
      if (!cmp.ok) return cmp;
      const c = cmp.value;
      switch (expr.op) {
        case 'lt':
          return ok(c < 0);
        case 'lte':
          return ok(c <= 0);
        case 'gt':
          return ok(c > 0);
        case 'gte':
          return ok(c >= 0);
      }
    }

    case 'in':
    case 'notIn': {
      const l = evaluate(expr.left, ctx);
      if (!l.ok) return l;
      const present = expr.right.some((candidate) => looseEquals(l.value, candidate));
      return ok(expr.op === 'in' ? present : !present);
    }

    case 'add':
    case 'sub':
    case 'min':
    case 'max': {
      const values: bigint[] = [];
      for (const arg of expr.args) {
        const v = evaluate(arg, ctx);
        if (!v.ok) return v;
        const n = asBigInt(v.value);
        if (!n.ok) return n;
        values.push(n.value);
      }
      const first = values[0];
      if (first === undefined) {
        return reject('OP-DETERMINACY', 'ARITHMETIC_NO_OPERANDS', 'Arithmetic requires operands', {
          op: expr.op,
        });
      }
      let acc = first;
      for (const v of values.slice(1)) {
        if (expr.op === 'add') acc += v;
        else if (expr.op === 'sub') acc -= v;
        else if (expr.op === 'min') acc = v < acc ? v : acc;
        else acc = v > acc ? v : acc;
      }
      return ok(acc);
    }

    case 'scaleBasisPoints': {
      const v = evaluate(expr.arg, ctx);
      if (!v.ok) return v;
      const n = asBigInt(v.value);
      if (!n.ok) return n;
      if (!Number.isInteger(expr.basisPoints) || expr.basisPoints < 0) {
        return reject(
          'OP-DETERMINACY',
          'BASIS_POINTS_INVALID',
          'Basis points must be a non-negative whole number',
          { basisPoints: expr.basisPoints },
        );
      }
      // Integer arithmetic, truncating toward zero. A limit rounds down.
      return ok((n.value * BigInt(expr.basisPoints)) / 10000n);
    }
  }
}

/** Evaluate and require a boolean. Used for conditions. */
export function evaluateCondition(expr: Expr, ctx: EvaluationContext): Result<boolean> {
  const v = evaluate(expr, ctx);
  if (!v.ok) return v;
  if (typeof v.value !== 'boolean') {
    return reject('OP-DETERMINACY', 'CONDITION_NOT_BOOLEAN', 'Condition did not evaluate to a boolean', {
      valueType: typeof v.value,
    });
  }
  return ok(v.value);
}

/** Evaluate and require an amount in minor units. Used for limit sizing. */
export function evaluateMoney(expr: Expr, ctx: EvaluationContext): Result<bigint> {
  const v = evaluate(expr, ctx);
  if (!v.ok) return v;
  return asBigInt(v.value);
}

// -----------------------------------------------------------------------------

function truthy(v: PolicyValue): boolean {
  return v === true;
}

function looseEquals(a: PolicyValue, b: PolicyValue): boolean {
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const an = asBigInt(a);
    const bn = asBigInt(b);
    return an.ok && bn.ok && an.value === bn.value;
  }
  return a === b;
}

function compareNumeric(a: PolicyValue, b: PolicyValue): Result<number> {
  const an = asBigInt(a);
  if (!an.ok) return an;
  const bn = asBigInt(b);
  if (!bn.ok) return bn;
  if (an.value < bn.value) return ok(-1);
  if (an.value > bn.value) return ok(1);
  return ok(0);
}

function asBigInt(v: PolicyValue): Result<bigint> {
  if (typeof v === 'bigint') return ok(v);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) {
      return reject(
        'OP-DETERMINACY',
        'NON_INTEGER_IN_FINANCIAL_PATH',
        'Policy arithmetic is integer only; express fractions as basis points',
        { value: v },
      );
    }
    return ok(BigInt(v));
  }
  return reject('OP-DETERMINACY', 'VALUE_NOT_NUMERIC', 'Expected a numeric value', {
    valueType: typeof v,
  });
}

/**
 * Resolve a dotted path against a plain object graph.
 *
 * Only own properties, only plain traversal — no prototype walking, no function
 * invocation. A policy file cannot reach anything the snapshot does not hold.
 */
export function pathResolver(root: object): (path: string) => PolicyValue | undefined {
  return (path: string) => {
    let current: unknown = root;
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    const t = typeof current;
    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
      return current as PolicyValue;
    }
    return undefined;
  };
}

/** Every field path a policy reads. Used to check a policy against a snapshot shape. */
export function referencedFields(expr: Expr, into: Set<string> = new Set()): Set<string> {
  if ('const' in expr || 'constMoneyMinorUnits' in expr) {
    /* literal */
  } else if (!('op' in expr)) {
    into.add(expr.field);
  } else {
    switch (expr.op) {
      case 'exists':
        into.add(expr.field);
        break;
      case 'not':
        referencedFields(expr.arg, into);
        break;
      case 'and':
      case 'or':
      case 'add':
      case 'sub':
      case 'min':
      case 'max':
        for (const a of expr.args) referencedFields(a, into);
        break;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
        referencedFields(expr.left, into);
        referencedFields(expr.right, into);
        break;
      case 'in':
      case 'notIn':
        referencedFields(expr.left, into);
        break;
      case 'scaleBasisPoints':
        referencedFields(expr.arg, into);
        break;
    }
  }
  return into;
}
