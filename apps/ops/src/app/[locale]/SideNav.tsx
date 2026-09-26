/**
 * The sidebar, to the Figma design: 250px, white, a 6px accent bar on the
 * reading-start edge of the active item, 18px medium labels, inactive items
 * in the design's grey. Groups and readiness survive from the previous
 * sidebar because they are true — a navigation that lists only what works
 * hides the product, and one that lists everything as if it worked is worse.
 */

import type { ReactElement } from 'react';

import { Icon } from '@sanad/design/icons.tsx';
import { MODULE_GROUPS, readinessTally, type ModuleReadiness } from '../../server/modules.ts';

const LEGEND_EN: Record<ModuleReadiness['kind'], string> = { LIVE: 'live', NOT_BUILT: 'not built', BLOCKED: 'blocked', EXCLUDED_THIS_PHASE: 'excluded this phase' };
const LEGEND_AR: Record<ModuleReadiness['kind'], string> = { LIVE: 'متاح', NOT_BUILT: 'لم يُبنَ بعد', BLOCKED: 'معلّق', EXCLUDED_THIS_PHASE: 'مستبعد في هذه المرحلة' };

function note(readiness: ModuleReadiness): string | undefined {
  if (readiness.kind === 'BLOCKED') return readiness.on;
  if (readiness.kind === 'EXCLUDED_THIS_PHASE') return readiness.basis;
  return undefined;
}

export function SideNav({ segment, arabic, current }: { readonly segment: string; readonly arabic: boolean; readonly current: string }): ReactElement {
  const tally = readinessTally();
  const legend = arabic ? LEGEND_AR : LEGEND_EN;

  return (
    <nav aria-label={arabic ? 'وحدات المنصة' : 'Platform modules'} className="hidden w-[250px] shrink-0 flex-col border-e border-line bg-surface pt-3 lg:flex">
      {MODULE_GROUPS.map((group) => (
        <div key={group.id} className="mb-2 flex flex-col">
          <h2 className="ps-11 pt-3 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-faint">{arabic ? group.titleAr : group.titleEn}</h2>
          <ul className="flex list-none flex-col p-0">
            {group.items.map((item) => {
              const label = arabic ? item.titleAr : item.titleEn;
              const openable = item.readiness.kind === 'LIVE' && item.href !== undefined;
              const href = `/${segment}${item.href ?? ''}`;
              const active = openable && href === current;
              const why = note(item.readiness);
              const body = (
                <>
                  {/* The design's indicator: a 6px bar on the start edge, rounded on the inner side. */}
                  <span aria-hidden className={`nav-indicator absolute inset-y-1 start-0 w-[6px] rounded-e-[10px] bg-brand ${active ? 'opacity-100' : 'opacity-0'}`} />
                  <Icon name={group.icon} size={22} className={`ms-[43px] shrink-0 ${active ? 'text-brand' : openable ? 'text-ink-faint' : 'text-ink-faint/70'}`} />
                  <span className="flex min-w-0 flex-col">
                    <span className={`truncate text-[17px] font-medium leading-tight ${active ? 'text-brand' : openable ? 'text-ink-faint group-hover:text-heading' : 'text-ink-faint/80'}`}>{label}</span>
                    {item.readiness.kind !== 'LIVE' ? <span className="text-[0.6875rem] text-ink-faint">{legend[item.readiness.kind]}</span> : null}
                  </span>
                </>
              );
              return (
                <li key={item.id} className="relative">
                  {openable ? (
                    <a href={href} aria-current={active ? 'page' : undefined} title={item.reference} className="group press relative flex min-h-[52px] items-center gap-[26px] pe-4">{body}</a>
                  ) : (
                    <span aria-disabled="true" title={why ?? item.reference} className="relative flex min-h-[44px] items-center gap-[26px] pe-4">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="mt-auto border-t border-line px-6 py-4 text-[0.6875rem] text-ink-quiet">
        <p className="font-medium">{arabic ? 'حالة الوحدات' : 'Module readiness'}</p>
        <ul className="mt-1 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0">
          {(Object.keys(tally) as (keyof typeof tally)[]).map((kind) => (
            <li key={kind} className="flex items-center gap-1"><span className="tabular-nums">{tally[kind]}</span><span>{legend[kind]}</span></li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

/** The mobile design's bottom bar: the live, openable modules only. */
export function BottomNav({ segment, arabic, current }: { readonly segment: string; readonly arabic: boolean; readonly current: string }): ReactElement {
  const items = MODULE_GROUPS.flatMap((g) => g.items.filter((i) => i.readiness.kind === 'LIVE' && i.href !== undefined).map((i) => ({ ...i, icon: g.icon }))).slice(0, 5);
  return (
    <nav aria-label={arabic ? 'التنقل' : 'Navigation'} className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-surface px-2 py-2 lg:hidden">
      {items.map((item) => {
        const href = `/${segment}${item.href ?? ''}`;
        const active = href === current;
        return (
          <a key={item.id} href={href} aria-current={active ? 'page' : undefined} className={`press flex min-w-[56px] flex-col items-center gap-1 rounded-tile px-2 py-1 text-[0.6875rem] ${active ? 'text-brand' : 'text-ink-faint'}`}>
            <Icon name={item.icon} size={22} />
            <span className="truncate">{arabic ? item.titleAr : item.titleEn}</span>
          </a>
        );
      })}
    </nav>
  );
}
