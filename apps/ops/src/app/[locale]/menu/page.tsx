/**
 * The menu: every module of the platform on one page, after Unity's product
 * directory (chosen 2026-11-04). A search, a chip per group, then each group
 * as a list of rows: the module, where the specification defines it, its
 * readiness, and Open where there is a screen to open.
 *
 * This is what the sidebar used to be. The map passed sixty entries; listed
 * in a sidebar it pushed the page off the screen and hid where you were. The
 * sidebar now keeps the pinned shortcuts, and this page keeps the truth about
 * everything else: a module that is not built, blocked or excluded is listed
 * here with that said, never dropped (CLAUDE.md §13).
 *
 * Narrowed by the deployment's jurisdiction (ADR 0005), as the sidebar is.
 * Server-rendered: the search and the chips are a GET form and links, so the
 * page works without a script.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { Icon } from '@sanad/design/icons.tsx';
import { Status, type StatusTone } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { workbenchJurisdiction } from '../../../server/jurisdiction.ts';
import type { ModuleReadiness } from '../../../server/modules.ts';
import { pageStaff } from '../../../server/session.ts';
import { NavLabel } from '../SideNav.tsx';
import { navigationFor, searchModules, tallyOf } from '../navigation.ts';

const READINESS: Readonly<
  Record<ModuleReadiness['kind'], { readonly tone: StatusTone; readonly en: string; readonly ar: string }>
> = {
  LIVE: { tone: 'settled', en: 'Live', ar: 'متاح' },
  NOT_BUILT: { tone: 'progress', en: 'Not built', ar: 'لم يُبنَ بعد' },
  BLOCKED: { tone: 'blocked', en: 'Blocked', ar: 'معلّق' },
  EXCLUDED_THIS_PHASE: { tone: 'progress', en: 'Excluded this phase', ar: 'مستبعد في هذه المرحلة' },
};

/** Why a module cannot be opened, where the map says. */
function reasonOf(readiness: ModuleReadiness): string | undefined {
  if (readiness.kind === 'BLOCKED') return readiness.on;
  if (readiness.kind === 'EXCLUDED_THIS_PHASE') return readiness.basis;
  return undefined;
}

export default async function MenuPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | undefined>>>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const q = await searchParams;
  await pageStaff(segment);
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const count = new Intl.NumberFormat(arabic ? 'ar-SA' : 'en-GB');

  const jurisdiction = await workbenchJurisdiction();
  const all = navigationFor(jurisdiction.code);
  const query = (q['q'] ?? '').trim().slice(0, 80);
  const chosen = all.some((g) => g.id === q['group']) ? q['group'] : undefined;
  const found = searchModules(all, query);
  const shown = chosen === undefined ? found : found.filter((g) => g.id === chosen);
  const tally = tallyOf(all);
  const chipHref = (group: string | undefined): string => {
    const p = new URLSearchParams();
    if (query !== '') p.set('q', query);
    if (group !== undefined) p.set('group', group);
    const s = p.toString();
    return `/${segment}/menu${s === '' ? '' : `?${s}`}`;
  };
  const chip = (on: boolean) =>
    `press inline-flex items-center gap-2 rounded-pill border px-3.5 py-1.5 text-[13px] font-medium ${
      on ? 'border-brand-deep bg-brand-deep text-on-brand' : 'border-line-strong bg-surface text-ink hover:bg-sunken'
    }`;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{t('All modules', 'كل الوحدات')}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {arabic
            ? `${count.format(tally.LIVE)} متاحة · ${count.format(tally.NOT_BUILT)} لم تُبنَ بعد · ${count.format(tally.BLOCKED)} معلّقة${tally.EXCLUDED_THIS_PHASE > 0 ? ` · ${count.format(tally.EXCLUDED_THIS_PHASE)} مستبعدة في هذه المرحلة` : ''}`
            : `${String(tally.LIVE)} live · ${String(tally.NOT_BUILT)} not built · ${String(tally.BLOCKED)} blocked${tally.EXCLUDED_THIS_PHASE > 0 ? ` · ${String(tally.EXCLUDED_THIS_PHASE)} excluded this phase` : ''}`}
        </p>
      </div>

      <form method="get" role="search" className="flex flex-col gap-3">
        {chosen === undefined ? null : <input type="hidden" name="group" value={chosen} />}
        <label className="flex h-11 items-center gap-2.5 rounded-tile border border-line-strong bg-surface ps-3.5 pe-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
          <Icon name="search" size={18} className="shrink-0 text-ink-quiet" />
          <span className="sr-only">{t('Search modules', 'ابحث في الوحدات')}</span>
          <input
            type="search"
            name="q"
            defaultValue={query}
            autoComplete="off"
            placeholder={t('Search modules, rails or references', 'ابحث عن وحدة أو قناة أو مرجع')}
            className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-quiet"
          />
        </label>
      </form>

      <nav aria-label={t('Groups', 'المجموعات')} className="flex flex-wrap gap-2">
        <a
          href={chipHref(undefined)}
          aria-current={chosen === undefined ? 'true' : undefined}
          className={chip(chosen === undefined)}
        >
          {t('All', 'الكل')}
        </a>
        {all.map((g) => (
          <a
            key={g.id}
            href={chipHref(g.id)}
            aria-current={g.id === chosen ? 'true' : undefined}
            className={chip(g.id === chosen)}
          >
            {arabic ? g.titleAr : g.titleEn}
          </a>
        ))}
      </nav>

      {shown.length === 0 ? (
        <p className="rounded-card bg-surface p-6 text-[15px] text-ink-quiet">
          {t('No module matches that search.', 'لا توجد وحدة تطابق هذا البحث.')}
        </p>
      ) : (
        shown.map((group) => (
          <section key={group.id} aria-labelledby={`group-${group.id}`} className="flex flex-col gap-2">
            <h3
              id={`group-${group.id}`}
              className="flex items-center gap-2 pt-2 text-[13px] font-semibold uppercase tracking-wider text-ink-quiet"
            >
              <Icon name={group.icon} size={16} />
              {arabic ? group.titleAr : group.titleEn}
              <span className="font-normal normal-case tracking-normal text-ink-faint">
                · {count.format(group.items.length)}
              </span>
            </h3>
            <ul className="card-lift flex list-none flex-col overflow-hidden rounded-card bg-surface p-0">
              {group.items.map((item) => {
                const openable = item.readiness.kind === 'LIVE' && item.href !== undefined;
                const r = READINESS[item.readiness.kind];
                const why = reasonOf(item.readiness);
                return (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-3.5 first:border-t-0"
                  >
                    <span
                      aria-hidden
                      className={`flex size-10 shrink-0 items-center justify-center rounded-tile ${openable ? 'bg-brand-wash text-brand' : 'bg-sunken text-ink-faint'}`}
                    >
                      <Icon name={group.icon} size={20} />
                    </span>
                    <span className="flex min-w-0 flex-1 basis-[240px] flex-col">
                      <span className={`text-[15px] font-medium ${openable ? 'text-heading' : 'text-ink'}`}>
                        <NavLabel text={arabic ? item.titleAr : item.titleEn} />
                      </span>
                      <span className="text-[12px] text-ink-quiet">{why ?? item.reference}</span>
                    </span>
                    <Status tone={r.tone} label={arabic ? r.ar : r.en} />
                    {openable ? (
                      <a
                        href={`/${segment}${item.href ?? ''}`}
                        className="press inline-flex min-w-[76px] items-center justify-center gap-1 rounded-tile border border-line-strong px-3 py-1.5 text-[13px] font-semibold text-heading hover:border-brand hover:text-brand"
                      >
                        {t('Open', 'فتح')}
                        <Icon name="chevron-end" size={16} />
                      </a>
                    ) : (
                      <span className="min-w-[76px]" />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
