/**
 * Mapping a rail's status vocabulary onto ours.
 *
 * Own keys only: a vendor status of "constructor" or "toString" must not find
 * an inherited property and read as a known value. Anything not in the table
 * is `undefined`, which every caller treats as malformed — an unknown status
 * is never the favourable one.
 */
export function lookupStatus<T>(table: Readonly<Record<string, T>>, value: unknown): T | undefined {
  return typeof value === 'string' && Object.hasOwn(table, value) ? table[value] : undefined;
}
