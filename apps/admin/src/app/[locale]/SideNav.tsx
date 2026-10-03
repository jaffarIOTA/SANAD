/**
 * The areas an institution configures. Listed in full, with what works
 * marked as such; a navigation that lists only what works hides the product.
 */

import type { ReactElement } from 'react';

import { Icon, type IconName } from '@sanad/design/icons.tsx';

interface Area { readonly id: string; readonly href?: string; readonly icon: IconName; readonly en: string; readonly ar: string; readonly state: 'LIVE' | 'NOT_BUILT' }

export const AREAS: readonly Area[] = [
  { id: 'credentials', href: '/credentials', icon: 'shield-check', en: 'Credentials', ar: 'بيانات الاعتماد', state: 'LIVE' },
  { id: 'products', icon: 'store', en: 'Products & modules', ar: 'المنتجات والوحدات', state: 'NOT_BUILT' },
  { id: 'rails', icon: 'plug', en: 'Rails & adapters', ar: 'قنوات التكامل', state: 'NOT_BUILT' },
  { id: 'identity', icon: 'settings', en: 'Staff identity (SSO)', ar: 'هوية الموظفين (الدخول الموحّد)', state: 'NOT_BUILT' },
  { id: 'partners', icon: 'document', en: 'Partner entitlements', ar: 'صلاحيات الشركاء', state: 'NOT_BUILT' },
];

export function SideNav({ segment, arabic, signedIn }: { readonly segment: string; readonly arabic: boolean; readonly signedIn: boolean }): ReactElement {
  return (
    <nav aria-label={arabic ? 'مناطق الإدارة' : 'Administration areas'} className="hidden w-[250px] shrink-0 border-e border-line bg-surface pt-6 lg:block">
      <h2 className="ps-[30px] pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{arabic ? 'الإعدادات' : 'Configuration'}</h2>
      <ul className="flex list-none flex-col p-0">
        {AREAS.map((a) => {
          const live = a.state === 'LIVE' && signedIn;
          const inner = (
            <>
              <Icon name={a.icon} size={22} className={`ms-[30px] shrink-0 ${live ? 'text-brand' : 'text-ink-faint'}`} />
              <span className="flex flex-col">
                <span className={`text-[16px] font-medium leading-snug ${live ? 'text-brand' : 'text-ink-faint'}`}>{arabic ? a.ar : a.en}</span>
                {a.state === 'NOT_BUILT' ? <span className="text-[11px] text-ink-faint">{arabic ? 'لم يُبنَ بعد' : 'not built'}</span> : null}
              </span>
            </>
          );
          return (
            <li key={a.id}>
              {live && a.href !== undefined
                ? <a href={`/${segment}${a.href}`} className="press relative flex min-h-[52px] items-center gap-4 py-2 pe-4">{inner}</a>
                : <span className="relative flex min-h-[52px] items-center gap-4 py-2 pe-4" aria-disabled>{inner}</span>}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
