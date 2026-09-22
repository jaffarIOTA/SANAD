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
      <span className="text-base text-ink">{first}</span>
      <span className="text-xs text-ink-quiet">{second}</span>
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[tone]}`}
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
}: {
  readonly children: ReactNode;
  readonly muted?: boolean;
}): ReactElement {
  return (
    <div
      className={`rounded-card border p-4 ${
        muted ? 'border-line bg-sunken opacity-80' : 'border-line bg-surface'
      }`}
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
