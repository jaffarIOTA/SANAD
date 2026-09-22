/**
 * Icons.
 *
 * Inline SVG, drawn here rather than pulled from a library. Twenty glyphs do
 * not justify a dependency a bank's supply-chain review has to account for
 * (SDD §6.12), and an icon set we own can be redrawn per client alongside the
 * tokens.
 *
 * All stroke, all on a 24 grid, all `currentColor` — so an icon inherits the
 * colour of whatever it sits in and needs no variant per surface.
 *
 * Every icon is `aria-hidden`. Without exception. An icon in this product
 * always sits beside its own label, because meaning carried by a glyph alone
 * fails the moment someone is using a screen reader, or is unfamiliar with the
 * metaphor, or is simply scanning quickly (NFR-09).
 */

import type { ReactElement } from 'react';

export type IconName =
  | 'dashboard'
  | 'key-in'
  | 'queue'
  | 'plug'
  | 'store'
  | 'people'
  | 'shield-check'
  | 'gauge'
  | 'exchange'
  | 'document'
  | 'banknote'
  | 'cycle'
  | 'building'
  | 'settings'
  | 'search'
  | 'clock'
  | 'inbox'
  | 'check-circle'
  | 'coins'
  | 'alert';

const PATHS: Record<IconName, ReactElement> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  'key-in': (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9" />
      <path d="M14 3v6h6" />
      <path d="M12 12v6M9 15h6" />
    </>
  ),
  queue: (
    <>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="19" cy="18" r="2.5" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v6M15 3v6" />
      <path d="M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9Z" />
      <path d="M12 18v3" />
    </>
  ),
  store: (
    <>
      <path d="M4 9h16l-1-5H5L4 9Z" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 5.5a3.5 3.5 0 0 1 0 7M17.5 14.5A6.5 6.5 0 0 1 21.5 20" />
    </>
  ),
  'shield-check': (
    <>
      <path d="M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 14 4-4" />
      <circle cx="12" cy="18" r="1.5" />
    </>
  ),
  exchange: (
    <>
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  banknote: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 10v4M18 10v4" />
    </>
  ),
  cycle: (
    <>
      <path d="M20 12a8 8 0 0 1-13.7 5.7M4 12a8 8 0 0 1 13.7-5.7" />
      <path d="M4 18v-4h4M20 6v4h-4" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V6l8-3 8 3v15" />
      <path d="M9 21v-5h6v5" />
      <path d="M8 9h1M15 9h1M8 12.5h1M15 12.5h1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V20a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 18.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 12.8H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.6 6.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H11a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V11a2 2 0 1 1 0 4h-.1Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13h4l1.5 3h6l1.5-3h4" />
      <path d="M5.5 5h13l2 8v4a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-4l2-8Z" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="9" cy="7" rx="5.5" ry="2.5" />
      <path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7" />
      <path d="M14.5 11.2c2.6.3 4.5 1.3 4.5 2.4v4c0 1.4-2.5 2.5-5.5 2.5-2.4 0-4.5-.7-5.2-1.7" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5 2.8 20h18.4L12 4.5Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}): ReactElement {
  return (
    <svg
      aria-hidden
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(className === undefined ? {} : { className })}
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * The tinted round chip the reference dashboards put behind a card's icon.
 * Decorative: it carries no meaning the label does not already carry.
 */
export function IconChip({
  name,
  tone = 'brand',
}: {
  readonly name: IconName;
  readonly tone?: 'brand' | 'positive' | 'attention' | 'neutral';
}): ReactElement {
  const tones = {
    brand: 'bg-brand-wash text-brand-deep',
    positive: 'bg-sunken text-positive',
    attention: 'bg-sunken text-attention',
    neutral: 'bg-sunken text-ink-quiet',
  } as const;

  return (
    <span
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full ${tones[tone]}`}
    >
      <Icon name={name} size={18} />
    </span>
  );
}
