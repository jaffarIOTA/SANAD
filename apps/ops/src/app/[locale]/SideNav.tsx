'use client';

/**
 * The sidebar: short on purpose. The module map has passed sixty entries and
 * grows with every rail and product, so the sidebar no longer lists it.
 * It holds the Menu entry, which opens the menu page listing every module
 * with its readiness (menu/page.tsx, after Unity's product directory, chosen
 * 2026-11-04); the pinned shortcuts (`pinned` in server/modules.ts); and the
 * page you are on when it is not pinned, so where you are is always shown.
 *
 * Narrowed by the deployment's jurisdiction (ADR 0005) through navigationFor
 * in navigation.ts, which reads each module's own `jurisdictions` tag in
 * server/modules.ts — never a list of ids.
 *
 * A client component only to read the path, so the item for the page you are
 * on — including every screen under it, such as /business/FR-…/offer — is
 * the one highlighted. The layout does not know the route.
 */

import { usePathname } from 'next/navigation';
import type { ReactElement } from 'react';

import { Icon, type IconName } from '@sanad/design/icons.tsx';
import {
  type NavJurisdiction,
  type NavShortcut,
  activeItemId,
  latinSuffix,
  navigationFor,
  sidebarOf,
} from './navigation.ts';

/**
 * An item's label. A Latin product name inside an Arabic label — 'الهوية
 * الرقمية (UAE Pass)' — is isolated with its parentheses and kept on one
 * line, so the bidi algorithm cannot mirror the brackets or split the name.
 */
export function NavLabel({ text }: { readonly text: string }): ReactElement {
  const split = latinSuffix(text);
  if (split === undefined) return <>{text}</>;
  // A no-break space keeps the name with the words it qualifies; the isolate keeps its parentheses the right way round.
  return (
    <>
      {split.before}{' '}
      <bdi dir="ltr" className="whitespace-nowrap">
        {split.latin}
      </bdi>
    </>
  );
}

function NavLink({
  href,
  icon,
  label,
  active,
  title,
}: {
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
  readonly active: boolean;
  readonly title?: string;
}): ReactElement {
  return (
    <li className="relative">
      {active ? <span aria-hidden className="absolute inset-y-1 start-0 w-1.5 rounded-e-full bg-brand" /> : null}
      <a
        href={href}
        aria-current={active ? 'page' : undefined}
        title={title}
        className={`group press relative flex min-h-[40px] items-center gap-3 rounded-tile py-2 pe-3 ${active ? 'bg-brand-wash' : 'hover:bg-sunken'}`}
      >
        <Icon
          name={icon}
          size={20}
          className={`ms-3 shrink-0 ${active ? 'text-brand' : 'text-ink-quiet group-hover:text-heading'}`}
        />
        <span
          className={`min-w-0 text-[14px] font-medium leading-snug ${active ? 'text-brand-deep' : 'text-ink group-hover:text-heading'}`}
        >
          <NavLabel text={label} />
        </span>
      </a>
    </li>
  );
}

function Heading({ children }: { readonly children: string }): ReactElement {
  return (
    <h2 className="ps-6 pt-2 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </h2>
  );
}

export function SideNav({
  segment,
  arabic,
  jurisdiction,
}: {
  readonly segment: string;
  readonly arabic: boolean;
  readonly jurisdiction: NavJurisdiction;
}): ReactElement {
  const pathname = usePathname();
  const groups = navigationFor(jurisdiction);
  const activeId = activeItemId(groups, segment, pathname);
  const { pinned, current } = sidebarOf(groups, activeId);
  const menuHref = `/${segment}/menu`;
  const onMenu = pathname.replace(/\/+$/, '') === menuHref;
  const link = (s: NavShortcut) => (
    <NavLink
      key={s.id}
      href={`/${segment}${s.href}`}
      icon={s.icon}
      label={arabic ? s.titleAr : s.titleEn}
      active={s.id === activeId}
      title={s.reference}
    />
  );

  return (
    <nav
      aria-label={arabic ? 'وحدات المنصة' : 'Platform modules'}
      className="hidden w-[248px] shrink-0 flex-col border-e border-line bg-surface pt-4 lg:flex"
    >
      <ul className="mb-3 flex list-none flex-col gap-0.5 px-3">
        <NavLink
          href={menuHref}
          icon="menu"
          label={arabic ? 'كل الوحدات' : 'All modules'}
          active={onMenu}
          title={arabic ? 'قائمة بكل وحدات المنصة وحالتها' : 'Every module of the platform, with its readiness'}
        />
      </ul>
      <div className="mb-3 flex flex-col">
        <Heading>{arabic ? 'المثبّتة' : 'Pinned'}</Heading>
        <ul className="flex list-none flex-col gap-0.5 px-3">{pinned.map(link)}</ul>
      </div>
      {current === undefined ? null : (
        <div className="mb-3 flex flex-col">
          <Heading>{arabic ? 'مفتوحة الآن' : 'Open now'}</Heading>
          <ul className="flex list-none flex-col gap-0.5 px-3">{link(current)}</ul>
        </div>
      )}
    </nav>
  );
}

/** The mobile bottom bar: the menu, then the first pinned shortcuts. */
export function BottomNav({
  segment,
  arabic,
  jurisdiction,
}: {
  readonly segment: string;
  readonly arabic: boolean;
  readonly jurisdiction: NavJurisdiction;
}): ReactElement {
  const pathname = usePathname();
  const groups = navigationFor(jurisdiction);
  const activeId = activeItemId(groups, segment, pathname);
  const { pinned } = sidebarOf(groups, activeId);
  const menuHref = `/${segment}/menu`;
  const entries = [
    {
      id: 'menu',
      href: menuHref,
      icon: 'menu' as IconName,
      label: arabic ? 'القائمة' : 'Menu',
      active: pathname.replace(/\/+$/, '') === menuHref,
    },
    ...pinned.slice(0, 4).map((s) => ({
      id: s.id,
      href: `/${segment}${s.href}`,
      icon: s.icon,
      label: arabic ? s.titleAr : s.titleEn,
      active: s.id === activeId,
    })),
  ];
  return (
    <nav
      aria-label={arabic ? 'التنقل' : 'Navigation'}
      className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-surface px-2 py-2 lg:hidden"
    >
      {entries.map((e) => (
        <a
          key={e.id}
          href={e.href}
          aria-current={e.active ? 'page' : undefined}
          className={`press flex min-w-0 flex-1 flex-col items-center gap-1 rounded-tile px-1 py-1 text-[0.6875rem] ${e.active ? 'text-brand' : 'text-ink-faint'}`}
        >
          <Icon name={e.icon} size={22} />
          <span className="max-w-full truncate">{e.label}</span>
        </a>
      ))}
    </nav>
  );
}
