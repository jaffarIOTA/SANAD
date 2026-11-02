/**
 * Sampling for the Shariah audit (BR-F05; Wasl W6c): which transactions the
 * Board looks at, chosen so that anyone can choose them again.
 *
 * Each candidate is ranked by the SHA-256 of the seed and its reference; the
 * sample is the first `size` of that order. The seed is shown with the
 * sample, so an auditor who repeats it with the same seed over the same
 * population gets the same transactions — and nobody, including whoever ran
 * the system, can steer which ones by choosing the order they are listed in.
 *
 * Pure. The hash is supplied by the caller (node:crypto in the service), so
 * core stays free of I/O and of any library.
 */

export interface Sample<T> {
  readonly seed: string;
  readonly population: number;
  readonly chosen: readonly T[];
}

/** The first `size` of `population`, ordered by hash(seed|reference). Reproducible for the same seed and population. */
export function sampleOf<T>(
  population: readonly T[],
  referenceOf: (t: T) => string,
  seed: string,
  size: number,
  sha256: (text: string) => string,
): Sample<T> {
  const n = Number.isInteger(size) && size > 0 ? Math.min(size, population.length) : 0;
  const ranked = population
    .map((t) => ({ t, rank: sha256(`${seed}|${referenceOf(t)}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  return { seed, population: population.length, chosen: ranked.slice(0, n).map((x) => x.t) };
}
