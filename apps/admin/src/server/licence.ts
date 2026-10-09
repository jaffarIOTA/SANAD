/**
 * Admin → Licence, as plain data: the installation's licence history grouped
 * into supersession chains, so a POC's whole length — every monthly extension
 * — is one visible line, and an ANNUAL that converted it follows on.
 *
 * Display only. Which licence is in force and what it permits is decided by
 * `licenceState` and `assertNewBusinessPermitted` in core/licensing.
 */

import { type CivilDate, parseDate } from '@sanad/core/licensing/dates.ts';
import { type Licence, parseRevocation } from '@sanad/core/licensing/licence.ts';
import type { InstalledEntry } from '@sanad/core/licensing/repository.ts';
import type { LicenceState } from '@sanad/core/licensing/state.ts';

export interface LicenceRow {
  readonly licence: Licence;
  readonly installedBy: string;
  readonly approvedBy: string | null;
  readonly source: InstalledEntry['source'];
  readonly installedAtEpochSeconds: bigint;
  readonly effective: boolean;
}

export interface LicenceChain {
  /** Oldest first: each one supersedes the one before it. */
  readonly rows: readonly LicenceRow[];
  readonly from: string;
  readonly to: string;
  /** Whole calendar months from the first notBefore to the last notAfter. */
  readonly months: number;
  readonly pocMonths: number;
}

export interface RevocationRow {
  readonly revocationId: string;
  readonly licenceId: string;
  readonly effectiveFrom: string;
  readonly source: InstalledEntry['source'];
}

const monthsBetween = (a: CivilDate, b: CivilDate): number =>
  (b.year - a.year) * 12 + (b.month - a.month) - (b.day < a.day ? 1 : 0);

/** Chains of verified licences, newest chain first. A licence whose predecessor is not installed starts a chain. */
export function licenceChains(state: LicenceState, history: readonly InstalledEntry[]): readonly LicenceChain[] {
  const byId = new Map(state.licences.map((l) => [l.licenceId, l]));
  const entry = new Map(history.map((e) => [e.subjectId, e]));
  const row = (l: Licence): LicenceRow => {
    const e = entry.get(l.licenceId);
    return {
      licence: l,
      installedBy: e?.installedBy ?? '—',
      approvedBy: e?.approvedBy ?? null,
      source: e?.source ?? 'ADMIN_INSTALL',
      installedAtEpochSeconds: e?.installedAtEpochSeconds ?? 0n,
      effective: state.effective?.licenceId === l.licenceId,
    };
  };
  // ISO dates sort as text; the earliest successor continues the chain.
  const successors = (id: string): Licence[] =>
    state.licences.filter((l) => l.supersedes === id).sort((a, b) => a.notBefore.localeCompare(b.notBefore));
  const roots = state.licences.filter((l) => l.supersedes === null || !byId.has(l.supersedes));
  const chains: LicenceChain[] = [];
  for (const root of roots) {
    const rows: LicenceRow[] = [];
    const seen = new Set<string>();
    let current: Licence | undefined = root;
    while (current !== undefined && !seen.has(current.licenceId)) {
      seen.add(current.licenceId);
      rows.push(row(current));
      current = successors(current.licenceId)[0];
    }
    const first = rows[0]?.licence;
    const last = rows[rows.length - 1]?.licence;
    if (first === undefined || last === undefined) continue;
    const from = parseDate(first.notBefore);
    const to = parseDate(last.notAfter);
    chains.push({
      rows,
      from: first.notBefore,
      to: last.notAfter,
      months: from === undefined || to === undefined ? 0 : monthsBetween(from, to),
      pocMonths: rows.filter((r) => r.licence.kind === 'POC').length,
    });
  }
  return chains.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));
}

/** Installed revocations, as recorded. Whether one verified is the state's business; this only lists them. */
export function revocationRows(history: readonly InstalledEntry[]): readonly RevocationRow[] {
  const rows: RevocationRow[] = [];
  for (const e of history) {
    if (e.kind !== 'REVOCATION') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.document);
    } catch {
      continue;
    }
    const r = parseRevocation(parsed);
    if (r.ok)
      rows.push({
        revocationId: r.value.revocationId,
        licenceId: r.value.licenceId,
        effectiveFrom: r.value.effectiveFrom,
        source: e.source,
      });
  }
  return rows;
}
