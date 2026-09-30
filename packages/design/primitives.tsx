/**
 * Shared primitives.
 *
 * Small on purpose. The components that matter here are the ones that carry a
 * domain rule — amounts, dates, gate states, refusals — and those are ours
 * rather than a library's, because a third party has no reason to know that a
 * date with contractual effect must show both calendars, or that a decline has
 * to name the control that produced it.
 *
 * Everything below uses logical properties and logical Tailwind utilities:
 * `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, never `ml-`/`mr-`/`left-`/`right-`.
 * Arabic is the design default and English is the mirror (FP-01, AP-10), so a
 * physical direction is a bug waiting for the first RTL review. A test fails
 * the build on one.
 */

import type { ReactElement, ReactNode } from 'react';

import { Icon, type IconName } from './icons.tsx';

import {
  LANGUAGE_NAME,
  otherSegment,
  type LocaleSegment,
} from '@sanad/i18n/strings.ts';

// -- The mark -----------------------------------------------------------------

/**
 * The Sanad mark.
 *
 * Two interlocking angular hooks around a square void, reading as an S.
 * Traced from the supplied raster: the geometry is straight edges and
 * 45-degree diagonals, so this is close — but it is still a trace, and the
 * original vector should replace it before anything is printed or sent
 * outside the team.
 *
 * Drawn in `currentColor` rather than a fixed fill, so the same mark serves
 * the orange and the mono lockups without a second copy.
 */
export function BrandMark({
  size = 32,
  tone = 'brand',
}: {
  readonly size?: number;
  readonly tone?: 'brand' | 'ink' | 'inherit';
}): ReactElement {
  const colour =
    tone === 'brand' ? 'var(--color-brand)' : tone === 'ink' ? 'var(--color-ink)' : 'currentColor';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Sanad"
      fill={colour}
      data-placeholder="traced from raster; awaiting original vector"
    >
      {/* Upper hook: top bar, chamfered at the top right, turning down the left. */}
      <path d="M6 6 H70 L94 30 H64 V36 H36 V64 H6 Z" />
      {/* Lower hook: the same form rotated about the centre. */}
      <path d="M94 94 H30 L6 70 H36 V64 H64 V36 H94 Z" />
    </svg>
  );
}

/**
 * The full lockup: mark, wordmark, and the endorsement rule beneath it.
 *
 * Used where the product introduces itself — a sign-in screen, an exported
 * audit pack cover. The header uses the mark alone, because a wordmark
 * repeated on every screen is noise rather than branding.
 */
export function BrandLockup({
  size = 96,
  tone = 'brand',
}: {
  readonly size?: number;
  readonly tone?: 'brand' | 'ink';
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-4">
      <BrandMark size={size} tone={tone} />
      <div className="flex flex-col items-center gap-1">
        <span className="text-2xl font-light tracking-[0.35em] text-ink-quiet">SANAD</span>
        <span className="flex items-center gap-3 text-[0.625rem] tracking-[0.2em] text-ink-quiet">
          <span aria-hidden className="h-px w-8 bg-line-strong" />
          AN IOTA PRODUCT
          <span aria-hidden className="h-px w-8 bg-line-strong" />
        </span>
      </div>
    </div>
  );
}

// -- Dates --------------------------------------------------------------------

export interface DualDateProps {
  /** Both are stored, never converted at read time, so a stored date cannot shift. */
  readonly gregorian: string;
  readonly hijri: string;
  readonly locale: 'ar-SA' | 'en-SA';
  /** Which calendar leads is a user preference (NFR-08). */
  readonly leading?: 'hijri' | 'gregorian';
}

/**
 * Both calendars, wherever a date has contractual effect.
 *
 * The two values come from storage rather than from a conversion, because a
 * date converted at render time is a date that can move between two renders
 * (SDD §7.5, DP-06).
 */
export function DualDate({
  gregorian,
  hijri,
  locale,
  leading,
}: DualDateProps): ReactElement {
  const lead = leading ?? (locale === 'ar-SA' ? 'hijri' : 'gregorian');
  const [first, second] = lead === 'hijri' ? [hijri, gregorian] : [gregorian, hijri];

  return (
    <span className="inline-flex flex-col items-start" data-testid="dual-date">
      {/*
        Each calendar is bidi-isolated. Without this an RTL page renders
        "18 September 2026" as "September 2026 18": the digits are neutral and
        get pulled to the reading end. The Hijri string is Arabic and stays
        put; the Gregorian one is Latin and must be told its own direction.
      */}
      <bdi className="text-base text-ink">{first}</bdi>
      <bdi className="text-xs text-ink-quiet">{second}</bdi>
    </span>
  );
}

// -- Status -------------------------------------------------------------------

export type StatusTone = 'available' | 'progress' | 'settled' | 'blocked';

const TONE: Record<StatusTone, string> = {
  available: 'bg-brand-wash text-brand-deep border-brand/40',
  progress: 'bg-sunken text-ink-quiet border-line-strong',
  settled: 'bg-sunken text-positive border-positive/40',
  blocked: 'bg-blocked-wash text-blocked border-blocked/40',
};

/**
 * A shared vocabulary of states, so the same state never looks different on
 * two surfaces (SDD §7.6).
 *
 * Meaning is never carried by colour alone — every status has a label, which
 * is what makes it legible to a screen reader and to anyone who does not
 * distinguish the hues.
 */
export function Status({
  tone,
  label,
}: {
  readonly tone: StatusTone;
  readonly label: string;
}): ReactElement {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[tone]}`}
      data-testid="status"
      data-tone={tone}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

// -- Refusals -----------------------------------------------------------------

export interface ControlRejectionProps {
  /** The Shariah or operational control that blocked it, e.g. `SH-10`. */
  readonly control: string;
  /** Rendered from the control code into a specific, respectful explanation. */
  readonly explanation: string;
  readonly controlLabel: string;
}

/**
 * A refusal, explained.
 *
 * Never a generic decline. Every compliance rejection names the control that
 * produced it, and the counterparty is told in their own language why — which
 * is both an audit requirement and simple decency when someone has been
 * refused credit (FP-06, BE-05, RC-11).
 */
export function ControlRejection({
  control,
  explanation,
  controlLabel,
}: ControlRejectionProps): ReactElement {
  return (
    <div
      role="note"
      className="rounded-card border border-blocked/30 bg-blocked-wash p-4"
      data-testid="control-rejection"
      data-control={control}
    >
      <p className="text-sm text-ink">{explanation}</p>
      <p className="mt-2 text-xs text-ink-quiet">
        {controlLabel} <span className="identifier">{control}</span>
      </p>
    </div>
  );
}

// -- Layout -------------------------------------------------------------------

export function Card({
  children,
  muted = false,
  className = '',
}: {
  readonly children: ReactNode;
  readonly muted?: boolean;
  /** Layout-only classes from the caller (grid span, min height). Never colour or radius. */
  readonly className?: string;
}): ReactElement {
  return (
    <div
      className={`card-lift min-w-0 rounded-card p-6 ${
        muted ? 'border border-line bg-sunken opacity-80' : 'bg-surface'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * The primary action. Uses the darker brand derivative rather than the mark's
 * orange, because white on the mark's orange measures about 3.1:1 and body
 * text needs 4.5:1 (NFR-09).
 */
export function PrimaryAction({
  children,
  href,
}: {
  readonly children: ReactNode;
  readonly href: string;
}): ReactElement {
  return (
    <a
      href={href}
      className="inline-flex min-h-tap w-full items-center justify-center rounded-card bg-brand-strong px-5 text-base font-semibold text-on-brand hover:bg-brand-deep"
    >
      {children}
    </a>
  );
}

// -- Language ----------------------------------------------------------------

/**
 * The language switch.
 *
 * Each language is named in its own script — العربية, not "Arabic" — because
 * the person who needs this control is by definition not reading the language
 * currently on screen.
 *
 * It links to the other locale's root rather than the same path translated.
 * Preserving the exact position across a language change needs the router, and
 * a switch that silently lands you somewhere unexpected is worse than one that
 * obviously returns you home. Worth revisiting once there are deeper journeys.
 */
export function LanguageSwitch({
  current,
}: {
  readonly current: LocaleSegment;
}): ReactElement {
  const other = otherSegment(current);

  return (
    <a
      href={`/${other}`}
      hrefLang={other}
      lang={other}
      className="inline-flex min-h-tap items-center rounded-card border border-line px-3 text-sm font-medium text-ink hover:bg-sunken"
      data-testid="language-switch"
    >
      {LANGUAGE_NAME[other]}
    </a>
  );
}

// =============================================================================
// Figma kit pieces (BankDash, applied 2026-09-28): tab strip, pill buttons,
// pagination, KPI tile, form field. Logical properties throughout.
// =============================================================================

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly count?: number;
}

/** The kit's tab strip: 16px medium, muted until active, a 3px accent underline on the active tab, a hairline under the row. */
export function Tabs({ items, current, ariaLabel }: { readonly items: readonly TabItem[]; readonly current: string; readonly ariaLabel: string }): ReactElement {
  return (
    <nav aria-label={ariaLabel} className="border-b border-line">
      <ul className="flex list-none flex-wrap gap-x-8 gap-y-1 p-0">
        {items.map((item) => {
          const active = item.id === current;
          return (
            <li key={item.id} className="relative shrink-0">
              <a href={item.href} aria-current={active ? 'page' : undefined} className={`press inline-flex min-h-tap items-center gap-2 pb-2 text-[16px] font-medium ${active ? 'text-brand-deep' : 'text-ink-quiet hover:text-heading'}`}>
                {item.label}
                {item.count !== undefined ? <span className={`rounded-full px-2 text-xs tabular-nums ${active ? 'bg-brand-wash text-brand-deep' : 'bg-sunken text-ink-quiet'}`}>{item.count}</span> : null}
              </a>
              <span aria-hidden className={`nav-indicator absolute inset-x-0 bottom-0 h-[3px] rounded-t-[10px] bg-brand-deep ${active ? 'opacity-100' : 'opacity-0'}`} />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const PILL = 'press inline-flex h-[35px] items-center justify-center gap-2 rounded-pill px-5 text-[15px] font-medium whitespace-nowrap';
export const PILL_OUTLINE = `${PILL} border border-brand-deep text-brand-deep hover:bg-brand-deep hover:text-white`;
export const PILL_FILLED = `${PILL} bg-brand-deep text-white hover:bg-brand`;
export const PILL_QUIET = `${PILL} border border-line-strong text-ink hover:bg-sunken`;
export const PILL_DANGER = `${PILL} border border-blocked/50 text-blocked hover:bg-blocked-wash`;

export function PillLink({ href, children, variant = 'outline' }: { readonly href: string; readonly children: ReactNode; readonly variant?: 'outline' | 'filled' | 'quiet' }): ReactElement {
  return <a href={href} className={variant === 'filled' ? PILL_FILLED : variant === 'quiet' ? PILL_QUIET : PILL_OUTLINE}>{children}</a>;
}

/** Previous · 1 2 3 · Next, the active page a 40px filled square with 10px corners. */
export function Pagination({ page, pages, hrefFor, labels }: { readonly page: number; readonly pages: number; readonly hrefFor: (page: number) => string; readonly labels: { readonly previous: string; readonly next: string } }): ReactElement | null {
  if (pages <= 1) return null;
  const window = Array.from({ length: pages }, (_, i) => i + 1).filter((p) => Math.abs(p - page) <= 2 || p === 1 || p === pages);
  return (
    <nav aria-label="pagination" className="flex items-center justify-end gap-2 text-[15px] font-medium text-brand-deep">
      {page > 1 ? <a href={hrefFor(page - 1)} className="press inline-flex min-h-tap items-center gap-1 px-2 hover:underline"><Icon name="chevron-start" size={14} />{labels.previous}</a> : <span className="inline-flex min-h-tap items-center gap-1 px-2 text-ink-faint"><Icon name="chevron-start" size={14} />{labels.previous}</span>}
      {window.map((p, i) => (
        <span key={p} className="contents">
          {i > 0 && (window[i - 1] ?? 0) < p - 1 ? <span className="px-1 text-ink-faint">…</span> : null}
          <a href={hrefFor(p)} aria-current={p === page ? 'page' : undefined} className={`press inline-flex size-10 items-center justify-center rounded-[10px] tabular-nums ${p === page ? 'bg-brand-deep text-white' : 'hover:bg-brand-wash'}`}>{p}</a>
        </span>
      ))}
      {page < pages ? <a href={hrefFor(page + 1)} className="press inline-flex min-h-tap items-center gap-1 px-2 hover:underline">{labels.next}<Icon name="chevron-end" size={14} /></a> : <span className="inline-flex min-h-tap items-center gap-1 px-2 text-ink-faint">{labels.next}<Icon name="chevron-end" size={14} /></span>}
    </nav>
  );
}

/** The Loans page tile: a 70px pastel disc with an icon, a muted label, a 20px value. */
export function Tile({ icon, disc, label, value }: { readonly icon: IconName; readonly disc: 'blue' | 'yellow' | 'pink' | 'teal'; readonly label: string; readonly value: ReactNode }): ReactElement {
  const bg = disc === 'blue' ? 'bg-disc-blue text-brand-deep' : disc === 'yellow' ? 'bg-disc-yellow text-attention' : disc === 'pink' ? 'bg-blocked-wash text-blocked' : 'bg-disc-teal text-positive';
  return (
    <div className="card-lift flex items-center gap-4 rounded-card bg-surface px-6 py-5">
      <span aria-hidden className={`inline-flex size-[70px] shrink-0 items-center justify-center rounded-full ${bg}`}><Icon name={icon} size={28} /></span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[16px] text-ink-quiet">{label}</span>
        <span className="truncate text-[20px] font-semibold text-ink tabular-nums">{value}</span>
      </span>
    </div>
  );
}

/** The Setting page field: 16px label, a 50px input with 15px corners and a soft border. */
export const FIELD_LABEL = 'block text-[16px] text-ink';
/** A selectable card in the kit's tile shape; the checked radio inside paints the border. */
export const CHOICE_CARD = 'flex min-h-tap cursor-pointer items-start gap-4 rounded-tile border border-line-strong bg-surface p-4 transition-colors hover:bg-sunken has-[:checked]:border-brand has-[:checked]:bg-disc-blue/40';
export const FIELD_INPUT = 'mt-2 block h-[50px] w-full rounded-tile border border-line-strong bg-surface px-5 text-[15px] text-ink outline-none placeholder:text-ink-quiet focus:border-brand focus:ring-2 focus:ring-brand/20';
export const FIELD_TEXTAREA = 'mt-2 block w-full rounded-tile border border-line-strong bg-surface px-5 py-3 text-[15px] text-ink outline-none placeholder:text-ink-quiet focus:border-brand focus:ring-2 focus:ring-brand/20';
/** The Save button: 190×50, 15px corners, filled. */
export const BUTTON_PRIMARY = 'press inline-flex h-[50px] min-w-[190px] items-center justify-center rounded-tile bg-brand-deep px-8 text-[18px] font-medium text-white hover:bg-brand';
export const BUTTON_SECONDARY = 'press inline-flex h-[50px] items-center justify-center rounded-tile border border-line-strong bg-surface px-8 text-[18px] font-medium text-ink hover:bg-sunken';
export const BUTTON_DANGER = 'press inline-flex h-[50px] items-center justify-center rounded-tile border border-blocked/50 bg-surface px-8 text-[18px] font-medium text-blocked hover:bg-blocked-wash';
