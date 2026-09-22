/**
 * The module navigation.
 *
 * Lists the whole platform, not just the finished parts, with each module's
 * readiness beside it. Unavailable modules are shown and disabled rather than
 * hidden — someone who cannot see a module assumes it was forgotten, and a
 * navigation that quietly omits an excluded capability is how an exclusion
 * turns into a backlog item nobody questions.
 *
 * A `<nav>` of real links and plain `<span>`s for what cannot be opened, so it
 * works without JavaScript and reads correctly to a screen reader. Logical
 * properties throughout, so it mirrors with the document direction.
 */

import type { ReactElement } from 'react';

import { Icon } from '@sanad/design/icons.tsx';
import { MODULE_GROUPS, readinessTally, type ModuleReadiness } from '../../server/modules.ts';

const DOT: Record<ModuleReadiness['kind'], string> = {
  LIVE: 'bg-brand',
  NOT_BUILT: 'bg-line-strong',
  BLOCKED: 'bg-attention',
  EXCLUDED_THIS_PHASE: 'bg-blocked',
};

const LEGEND_EN: Record<ModuleReadiness['kind'], string> = {
  LIVE: 'live',
  NOT_BUILT: 'not built',
  BLOCKED: 'blocked',
  EXCLUDED_THIS_PHASE: 'excluded this phase',
};

const LEGEND_AR: Record<ModuleReadiness['kind'], string> = {
  LIVE: 'متاح',
  NOT_BUILT: 'لم يُبنَ بعد',
  BLOCKED: 'معلّق',
  EXCLUDED_THIS_PHASE: 'مستبعد في هذه المرحلة',
};

function note(readiness: ModuleReadiness): string | undefined {
  if (readiness.kind === 'BLOCKED') return readiness.on;
  if (readiness.kind === 'EXCLUDED_THIS_PHASE') return readiness.basis;
  return undefined;
}

export function SideNav({
  segment,
  arabic,
  current,
}: {
  readonly segment: string;
  readonly arabic: boolean;
  readonly current: string;
}): ReactElement {
  const tally = readinessTally();
  const legend = arabic ? LEGEND_AR : LEGEND_EN;

  return (
    <nav
      aria-label={arabic ? 'وحدات المنصة' : 'Platform modules'}
      className="flex w-64 shrink-0 flex-col gap-5 border-e border-line bg-surface p-4"
    >
      {MODULE_GROUPS.map((group) => (
        <div key={group.id} className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2 px-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-quiet">
            <Icon name={group.icon} size={14} />
            {arabic ? group.titleAr : group.titleEn}
          </h2>

          <ul className="flex list-none flex-col p-0">
            {group.items.map((item) => {
              const label = arabic ? item.titleAr : item.titleEn;
              const openable = item.readiness.kind === 'LIVE' && item.href !== undefined;
              const href = `/${segment}${item.href ?? ''}`;
              const active = openable && href === current;
              const why = note(item.readiness);

              const dot = (
                <span
                  aria-hidden
                  className={`mt-1.5 size-1.5 shrink-0 rounded-full ${DOT[item.readiness.kind]}`}
                />
              );

              const text = (
                <span className="flex flex-col gap-0.5">
                  <span className="leading-snug">{label}</span>
                  {/* Readiness is also in words, not only in the dot's colour. */}
                  {item.readiness.kind !== 'LIVE' ? (
                    <span className="text-[0.6875rem] text-ink-quiet">
                      {legend[item.readiness.kind]}
                    </span>
                  ) : null}
                </span>
              );

              return (
                <li key={item.id}>
                  {openable ? (
                    <a
                      href={href}
                      aria-current={active ? 'page' : undefined}
                      title={item.reference}
                      className={`flex min-h-tap items-start gap-2 rounded-card px-2 py-2 text-sm ${
                        active
                          ? 'bg-brand-wash font-semibold text-brand-deep'
                          : 'text-ink hover:bg-sunken'
                      }`}
                    >
                      {dot}
                      {text}
                    </a>
                  ) : (
                    <span
                      aria-disabled="true"
                      title={why ?? item.reference}
                      className="flex min-h-tap items-start gap-2 rounded-card px-2 py-2 text-sm text-ink-quiet"
                    >
                      {dot}
                      {text}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="mt-auto border-t border-line pt-3 text-[0.6875rem] text-ink-quiet">
        <p className="font-medium">{arabic ? 'حالة الوحدات' : 'Module readiness'}</p>
        <ul className="mt-1 flex list-none flex-col gap-0.5 p-0">
          {(Object.keys(tally) as (keyof typeof tally)[]).map((kind) => (
            <li key={kind} className="flex items-center gap-2">
              <span aria-hidden className={`size-1.5 rounded-full ${DOT[kind]}`} />
              <span className="tabular-nums">{tally[kind]}</span>
              <span>{legend[kind]}</span>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
