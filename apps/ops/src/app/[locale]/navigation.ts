/**
 * The sidebar's logic, apart from its markup (SideNav.tsx), so it can be
 * tested without a browser.
 *
 * Narrowed by the deployment's jurisdiction (ADR 0005): a UAE deployment does
 * not list the Saudi products, the Saudi rails or the Murabaha SCF (Wasl)
 * workstreams; a Saudi deployment does not list the UAE rails or the UAE SME
 * direct-lending items. Platform-wide groups stay in both. The filter is by
 * known group and item ids because the module map does not carry a
 * jurisdiction tag yet — the cleaner change is a `jurisdictions` field on
 * each ModuleGroup / ModuleItem in server/modules.ts, after which these two
 * tables go away.
 */

import { MODULE_GROUPS, type ModuleGroup, type ModuleReadiness } from '../../server/modules.ts';

export type NavJurisdiction = 'SA' | 'AE';

/** Groups that exist for one jurisdiction only. */
const GROUP_JURISDICTION: Readonly<Record<string, NavJurisdiction>> = {
  rails: 'SA',
  // Murabaha SCF (Wasl) workstreams: anchors, programmes, goods, commodity brokers; drawdowns, sequencing gates, the financed-invoice registry.
  programmes: 'SA',
  transactions: 'SA',
  'uae-rails': 'AE',
  'sme-direct-uae': 'AE',
};

/** Items, inside platform-wide groups, that exist for one jurisdiction only. */
const ITEM_JURISDICTION: Readonly<Record<string, NavJurisdiction>> = {
  'murabaha-scf': 'SA',
  'tawarruq-personal': 'SA',
  bnpl: 'SA',
  merchants: 'SA',
  'embedded-lending': 'SA',
  'conventional-term': 'SA',
  // The aggregator channel nominates under a merchant mandate (the Saudi BNPL rails).
  embedded: 'SA',
};

/** The module map as this deployment's jurisdiction sees it. Groups left empty are dropped. */
export function navigationFor(code: NavJurisdiction, groups: readonly ModuleGroup[] = MODULE_GROUPS): readonly ModuleGroup[] {
  return groups
    .filter((g) => (GROUP_JURISDICTION[g.id] ?? code) === code)
    .map((g) => ({ ...g, items: g.items.filter((i) => (ITEM_JURISDICTION[i.id] ?? code) === code) }))
    .filter((g) => g.items.length > 0);
}

/** Readiness counts over what is listed, so the footer agrees with the list above it. */
export function tallyOf(groups: readonly ModuleGroup[]): Readonly<Record<ModuleReadiness['kind'], number>> {
  const tally = { LIVE: 0, NOT_BUILT: 0, BLOCKED: 0, EXCLUDED_THIS_PHASE: 0 };
  for (const group of groups) for (const item of group.items) tally[item.readiness.kind] += 1;
  return tally;
}

/**
 * The one item the path belongs to: the openable item whose href is the
 * longest prefix of the path at a segment boundary (the dashboard, href '',
 * only at the locale root). Several items can share an href (the three SME
 * entries all open /business); the first listed is the one marked.
 */
export function activeItemId(groups: readonly ModuleGroup[], segment: string, pathname: string): string | undefined {
  const path = pathname.replace(/\/+$/, '');
  let best: { readonly id: string; readonly length: number } | undefined;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.readiness.kind !== 'LIVE' || item.href === undefined) continue;
      const href = `/${segment}${item.href}`;
      const matches = item.href === '' ? path === href : path === href || path.startsWith(`${href}/`);
      if (matches && (best === undefined || href.length > best.length)) best = { id: item.id, length: href.length };
    }
  }
  return best?.id;
}

/**
 * An Arabic label ending in a parenthesised Latin name — 'الهوية الرقمية
 * (UAE Pass)' — split so the name and its parentheses can be isolated and
 * kept on one line. Undefined for any other label.
 */
export function latinSuffix(text: string): { readonly before: string; readonly latin: string } | undefined {
  const m = /^(.*\S)\s*\(([A-Za-z][A-Za-z0-9 .&-]*)\)\s*$/.exec(text);
  if (m === null || m[1] === undefined || m[2] === undefined || !/[؀-ۿ]/.test(m[1])) return undefined;
  return { before: m[1], latin: `(${m[2]})` };
}
