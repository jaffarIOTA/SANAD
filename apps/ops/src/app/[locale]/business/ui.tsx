/**
 * Shared pieces of the SME pipeline screens (stages 5–9, UAE direct lending):
 * formatting in the screen's language, the stage chip, the nine-stage
 * stepper, the application shell (title, stepper, sub-screens, notices and
 * refusals) and the card frames — to the workbench's Figma kit: white cards
 * on a 1px line, soft pills, uppercase metric labels, sunken table headers.
 *
 * Composed RTL-first in logical properties. Amounts arrive as minor units
 * and are formatted by `formatMinorUnits` (string arithmetic, no float), in
 * the tenant's currency with its label in the screen's language.
 */

import type { ReactElement, ReactNode } from 'react';

import { ControlRejection } from '@sanad/design/primitives.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import { formatMinorUnits } from '@sanad/design/Money.tsx';
import type { CurrencyCode } from '@sanad/core/kernel/money.ts';

import { type BusinessApplicationView, PIPELINE_STAGES } from '../../../server/business.ts';
import {
  type ChipTone,
  NOTICES,
  STATUS_WORDS,
  type ShellQuery,
  VARIANT_NOTE,
  arabicDigits,
  codeWords,
  humanise,
  refusalFromQuery,
  riskLevelWords,
} from '../../../server/business-dashboard.ts';

// The screens' words live in server/business-dashboard.ts (plain TypeScript, so the tests can import them); re-exported here for the pages.
export {
  LETTER_ACTION,
  ROUTE_LABELS,
  SEND_LABEL,
  type ShellQuery,
  humanise,
  splitOfferEmail,
} from '../../../server/business-dashboard.ts';
import { currencyLabel } from '../../../server/jurisdiction.ts';

// -- Formatting ---------------------------------------------------------------

export interface Formatters {
  readonly arabic: boolean;
  readonly t: (en: string, ar: string) => string;
  /** Minor units in the tenant's currency, grouped, two decimals. */
  readonly money: (minorUnits: bigint) => string;
  /** The currency word in the screen's language: AED / درهم. */
  readonly cur: string;
  readonly n: (count: number | bigint) => string;
  /** Latin digits to the screen's numerals in an already-formatted string. */
  readonly digits: (s: string) => string;
  /** A stored ISO date (yyyy-mm-dd), Gregorian, in the screen's language. */
  readonly isoDate: (iso: string) => string;
  /** An instant, as a UAE calendar date. */
  readonly epochDate: (epochSeconds: bigint) => string;
}

export function formatters(arabic: boolean, currency: CurrencyCode): Formatters {
  const numerals = arabic ? 'arabic-indic' : 'latin';
  const dateLocale = arabic ? 'ar-SA-u-ca-gregory' : 'en-GB';
  const dateFormat = (timeZone: string) =>
    new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'short', year: 'numeric', timeZone });
  return {
    arabic,
    t: (en, ar) => (arabic ? ar : en),
    money: (minorUnits) => formatMinorUnits({ minorUnits, currency }, numerals),
    cur: currencyLabel(currency, arabic),
    n: (count) => new Intl.NumberFormat(arabic ? 'ar-SA' : 'en-GB').format(count),
    digits: (s) => (arabic ? arabicDigits(s) : s),
    isoDate: (iso) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      return m === null
        ? iso
        : dateFormat('UTC').format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
    },
    epochDate: (epochSeconds) => dateFormat('Asia/Dubai').format(new Date(Number(epochSeconds) * 1000)),
  };
}

// -- Chips --------------------------------------------------------------------

const CHIP: Readonly<Record<ChipTone, string>> = {
  neutral: 'bg-sunken text-ink-quiet',
  brand: 'bg-brand-wash text-brand-deep',
  good: 'bg-positive-wash text-positive',
  warn: 'bg-attention-wash text-attention',
  bad: 'bg-blocked-wash text-blocked',
};

/** A soft pill with its label: meaning is never carried by colour alone. */
export function Chip({ tone, children }: { readonly tone: ChipTone; readonly children: ReactNode }): ReactElement {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-[6px] px-2.5 py-1 text-[12px] font-medium leading-snug ${CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status, f }: { readonly status: string; readonly f: Formatters }): ReactElement {
  const s = STATUS_WORDS[status] ?? { en: humanise(status), ar: 'حالة غير معروفة', tone: 'neutral' as const };
  return <Chip tone={s.tone}>{f.t(s.en, s.ar)}</Chip>;
}

export const METRIC_LABELS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  ANNUAL_REVENUE: { en: 'Annual revenue', ar: 'الإيرادات السنوية' },
  PRIOR_YEAR_REVENUE: { en: 'Prior-year revenue', ar: 'إيرادات السنة السابقة' },
  NET_PROFIT: { en: 'Net profit', ar: 'صافي الربح' },
  TOTAL_DEBT_SERVICE: { en: 'Total debt service', ar: 'إجمالي خدمة الدين' },
  CURRENT_ASSETS: { en: 'Current assets', ar: 'الأصول المتداولة' },
  CURRENT_LIABILITIES: { en: 'Current liabilities', ar: 'الخصوم المتداولة' },
  MONTHLY_GROSS_SALARY: { en: 'Owner’s monthly gross salary', ar: 'الراتب الشهري الإجمالي للمالك' },
  MONTHLY_DEBT_OBLIGATIONS: { en: 'Owner’s monthly debt obligations', ar: 'الالتزامات الشهرية على المالك' },
};

export const SECTOR_LABELS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  TRADING: { en: 'Trading', ar: 'تجارة' },
  SERVICES: { en: 'Services', ar: 'خدمات' },
  MANUFACTURING: { en: 'Manufacturing', ar: 'صناعة' },
};

/** A code's words from a bilingual map; an unmapped code is never shown raw (see `codeWords`). */
export const label = (
  map: Readonly<Record<string, { readonly en: string; readonly ar: string }>>,
  code: string,
  f: Formatters,
): string => codeWords(map, code, f.arabic);

/** A risk level's words: the policy's band label for it if given, else the static map. */
export const riskLevelLabel = (level: string, f: Formatters, bands?: Parameters<typeof riskLevelWords>[2]): string =>
  riskLevelWords(level, f.arabic, bands);

export function stageTitle(stage: number, f: Formatters): string {
  const s = PIPELINE_STAGES.find((x) => x.stage === stage);
  return s === undefined ? f.n(stage) : f.t(s.titleEn, s.titleAr);
}

/** "stages 5–9" with the screen's numerals. */
export const stageRange = (from: number, to: number, f: Formatters): string => `${f.n(from)}–${f.n(to)}`;

/**
 * An identifier inside running text — a version, a reference, a hash, a
 * principal id. Isolated so its hyphens and full stops do not take the
 * direction of the Arabic around them, and kept in Latin: it is a code to
 * copy, not a quantity to read.
 */
export function Id({ children, className }: { readonly children: string; readonly className?: string }): ReactElement {
  return (
    <bdi dir="ltr" className={`identifier ${className ?? ''}`}>
      {children}
    </bdi>
  );
}

/** The variant's provenance note, neutral and in the screen's language (VARIANT_NOTE in server/business-dashboard.ts). */
export const variantProvenanceNote = (f: Formatters): string => f.t(VARIANT_NOTE.en, VARIANT_NOTE.ar);

// -- Cards --------------------------------------------------------------------

export function SectionCard({
  title,
  note,
  aside,
  children,
  id,
}: {
  readonly title: string;
  readonly note?: ReactNode;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly id?: string;
}): ReactElement {
  return (
    <section id={id} className="min-w-0 rounded-card border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-heading">{title}</h2>
          {note === undefined || note === '' ? null : <p className="mt-0.5 text-[12px] text-ink-quiet">{note}</p>}
        </div>
        {aside === undefined ? null : <div className="flex flex-wrap items-center gap-2">{aside}</div>}
      </header>
      <div className="min-w-0 p-5">{children}</div>
    </section>
  );
}

/** A figure tile: uppercase label, the value large, one line of context. */
export function MetricTile({
  label,
  value,
  unit,
  sub,
  tone = 'quiet',
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly unit?: string;
  readonly sub?: ReactNode;
  readonly tone?: 'quiet' | 'good' | 'bad' | 'warn';
}): ReactElement {
  const subTone =
    tone === 'bad'
      ? 'text-blocked font-medium'
      : tone === 'good'
        ? 'text-positive'
        : tone === 'warn'
          ? 'text-attention font-medium'
          : 'text-ink-quiet';
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-line bg-surface px-5 py-4 shadow-card">
      <span className="truncate text-[12px] font-medium uppercase tracking-wide text-ink-quiet">{label}</span>
      <span className="mt-2 flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-[22px] font-bold leading-8 tabular-nums text-heading">{value}</span>
        {unit === undefined ? null : <span className="text-[13px] text-ink-quiet">{unit}</span>}
      </span>
      {sub === undefined ? null : <span className={`mt-1 text-[12px] ${subTone}`}>{sub}</span>}
    </div>
  );
}

/**
 * The division in a ratio's equation, in words at body size: a '÷' glyph at
 * a small muted size reads as '+', and an officer checking a ratio must not
 * have to guess the operator.
 */
export function DividedBy({ f }: { readonly f: Formatters }): ReactElement {
  return (
    <span className="text-[14px] font-semibold text-ink" data-operator="divide">
      {f.t('divided by', 'مقسوماً على')}
    </span>
  );
}

/** A label/value pair in a definition grid. */
export function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-quiet">{label}</dt>
      <dd className="mt-0.5 text-[14px] font-medium text-heading">{children}</dd>
    </div>
  );
}

const BASIS_WORDS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  STRAIGHT_THROUGH_AS_REQUESTED: {
    en: 'Approved straight through, as requested',
    ar: 'معتمد مباشرة كما طُلب',
  },
  COMMITTEE: { en: 'Approved by the credit committee', ar: 'اعتمدته لجنة الائتمان' },
  RECORDED_BEFORE_APPROVED_TERMS: {
    en: 'Decided before approved terms were recorded; read as the request',
    ar: 'تقرر قبل تسجيل الشروط المعتمدة؛ يُقرأ كما طُلب',
  },
};

/**
 * The request beside what was approved, once a decision approved it. Both
 * from the record — the screen compares nothing and decides nothing. Renders
 * nothing while the application is undecided or declined.
 */
export function RequestedVsApproved({
  view,
  f,
}: {
  readonly view: BusinessApplicationView;
  readonly f: Formatters;
}): ReactElement | null {
  const approved = view.approvedTerms;
  if (approved === undefined) return null;
  const a = view.application;
  const months = (n: number): string => f.t(`${f.n(n)} months`, `${f.n(n)} شهراً`);
  const lower = approved.amount.minorUnits < a.requested.minorUnits || approved.tenorMonths < a.tenorMonths;
  const basis = BASIS_WORDS[approved.basis];
  return (
    <div className="rounded-tile border border-line px-4 py-3" data-requested-vs-approved>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label={f.t('Requested', 'المطلوب')}>
          <bdi className="tabular-nums">{f.money(a.requested.minorUnits)}</bdi>{' '}
          <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
          <span className="text-[13px] font-normal text-ink-quiet"> · {months(a.tenorMonths)}</span>
        </Field>
        <Field label={f.t('Approved', 'المعتمد')}>
          <bdi className="tabular-nums" data-approved-amount>
            {f.money(approved.amount.minorUnits)}
          </bdi>{' '}
          <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
          <span className="text-[13px] font-normal text-ink-quiet"> · {months(approved.tenorMonths)}</span>
        </Field>
      </dl>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-ink-quiet">
        {basis === undefined ? null : <span>{f.t(basis.en, basis.ar)}</span>}
        {lower ? <Chip tone="warn">{f.t('Approved below the request', 'اعتُمد بأقل من المطلوب')}</Chip> : null}
      </p>
    </div>
  );
}

export const BTN_PRIMARY =
  'press inline-flex h-10 items-center justify-center gap-2 rounded-tile bg-brand px-4 text-[14px] font-semibold text-white hover:bg-brand-deep disabled:cursor-not-allowed disabled:bg-sunken disabled:text-ink-faint';
export const BTN_SECONDARY =
  'press inline-flex h-10 items-center justify-center gap-2 rounded-tile border border-line-strong bg-surface px-4 text-[14px] font-semibold text-heading hover:bg-sunken disabled:cursor-not-allowed disabled:text-ink-faint';
export const BTN_SMALL =
  'press inline-flex h-8 items-center justify-center gap-1 rounded-tile border border-line-strong bg-surface px-3 text-[13px] font-semibold text-heading hover:bg-sunken';
export const INPUT =
  'h-9 w-full min-w-0 rounded-tile border border-line-strong bg-surface px-3 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-brand focus:ring-2 focus:ring-brand/20';
const TH_BASE = 'py-3 pe-3 text-[12px] font-medium text-ink-quiet';
/** A text column's header: start-aligned. */
export const TH = `${TH_BASE} text-start`;
/**
 * A numeric column's header: end-aligned over end-aligned figures. Its own
 * constant, because `TH` plus `text-end` puts two alignments on one element
 * and whichever Tailwind emits later wins — the header then sits at the
 * start while its figures sit at the end.
 */
export const TH_END = `${TH_BASE} text-end`;

/** A primary action that is not available yet, with the reason in words beside it. */
export function DisabledAction({
  label,
  reason,
}: {
  readonly label: string;
  readonly reason: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button type="button" disabled className={BTN_PRIMARY}>
        {label}
      </button>
      <p className="max-w-[48ch] text-[12px] text-ink-quiet">{reason}</p>
    </div>
  );
}

/** Hidden fields every business form carries: where it acts and where to come back to. */
export function FormContext({
  segment,
  applicationId,
  screen,
}: {
  readonly segment: string;
  readonly applicationId: string;
  readonly screen?: 'assessment' | 'offer';
}): ReactElement {
  return (
    <>
      <input type="hidden" name="locale" value={segment} />
      <input type="hidden" name="applicationId" value={applicationId} />
      {screen === undefined ? null : <input type="hidden" name="screen" value={screen} />}
    </>
  );
}

// -- The stepper ----------------------------------------------------------------

/**
 * The nine stages, the current one marked; 1–4 happen upstream and are shown
 * done once handed over.
 *
 * The number sits above the title, not beside it, so the title has the whole
 * card's width; titles wrap at word boundaries (and break inside a word only
 * as a last resort), and each card keeps a minimum width — below it the strip
 * scrolls inside its own `relative overflow-x-auto` box rather than letting a
 * word cross a card's border.
 */
export function StageStepper({
  current,
  closed,
  f,
}: {
  readonly current: number;
  readonly closed: boolean;
  readonly f: Formatters;
}): ReactElement {
  return (
    <div className="relative overflow-x-auto pb-1">
      <ol
        aria-label={f.t('Pipeline stages', 'مراحل الطلب')}
        className="flex min-w-max list-none gap-2 p-0 xl:grid xl:min-w-0 xl:grid-cols-9"
      >
        {PIPELINE_STAGES.map((s) => {
          const done = s.stage < current;
          const here = s.stage === current;
          const ring = here
            ? closed
              ? 'border-blocked/50 bg-blocked-wash'
              : 'border-brand bg-brand-wash'
            : done
              ? 'border-line bg-surface'
              : 'border-dashed border-line-strong bg-surface';
          const dot = here
            ? closed
              ? 'bg-blocked-mark text-white'
              : 'bg-brand text-white'
            : done
              ? 'bg-positive-wash text-positive'
              : 'bg-sunken text-ink-quiet';
          return (
            <li
              key={s.stage}
              aria-current={here ? 'step' : undefined}
              data-stage={s.stage}
              className={`flex w-[112px] min-w-0 shrink-0 flex-col items-start gap-1.5 overflow-hidden rounded-tile border px-2.5 py-2 xl:w-auto ${ring}`}
            >
              <span
                aria-hidden
                className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${dot}`}
              >
                {done ? '✓' : f.n(s.stage)}
              </span>
              <span className="flex w-full min-w-0 flex-col leading-tight">
                <span
                  className={`hyphens-auto text-[11.5px] font-semibold wrap-anywhere ${here ? 'text-brand-deep' : done ? 'text-heading' : 'text-ink-quiet'}`}
                >
                  {f.t(s.titleEn, s.titleAr)}
                </span>
                <span className="mt-0.5 text-[11px] text-ink-quiet">
                  {s.owner === 'UPSTREAM' ? f.t('Upstream', 'خارج سند') : f.t('Sanad', 'سند')}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// -- The application shell ------------------------------------------------------

export function ApplicationShell({
  segment,
  view,
  screen,
  query,
  f,
  title,
  children,
}: {
  readonly segment: string;
  readonly view: BusinessApplicationView;
  readonly screen: 'application' | 'assessment' | 'offer';
  readonly query: ShellQuery;
  readonly f: Formatters;
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  const a = view.application;
  const base = `/${segment}/business/${encodeURIComponent(a.applicationId)}`;
  const tabs = [
    { id: 'application', href: base, label: f.t('Loan application', 'طلب التمويل'), stage: 5 },
    { id: 'assessment', href: `${base}/assessment`, label: f.t('Credit assessment', 'التقييم الائتماني'), stage: 6 },
    { id: 'offer', href: `${base}/offer`, label: f.t('Offer & contract', 'العرض والعقد'), stage: 7 },
  ] as const;
  const notice = query.notice === undefined ? undefined : NOTICES[query.notice];
  const refusal = refusalFromQuery(query, f.arabic);
  const closed = a.status === 'WITHDRAWN' || a.status === 'DECLINED';
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <a
            href={`/${segment}/business`}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"
          >
            <Icon name="chevron-start" size={14} />
            {f.t('Business applications', 'طلبات المنشآت')}
          </a>
          <h1 className="mt-1 text-h1 font-bold tracking-tight text-heading">{title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-quiet">
            <span className="font-semibold text-heading">
              {f.arabic ? (a.applicant.businessNameAr ?? a.applicant.businessNameEn) : a.applicant.businessNameEn}
            </span>
            <span aria-hidden>·</span>
            <Id>{a.applicationId}</Id>
            <StatusPill status={a.status} f={f} />
          </p>
        </div>
      </div>

      <StageStepper current={view.displayStage} closed={closed} f={f} />

      <nav aria-label={f.t('Application screens', 'شاشات الطلب')} className="border-b border-line">
        <ul className="-mb-px flex list-none flex-wrap gap-1 p-0">
          {tabs.map((tab) => {
            const active = tab.id === screen;
            return (
              <li key={tab.id}>
                <a
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={`press inline-flex items-center gap-2 border-b-2 px-3 pb-3 text-[14px] font-medium ${active ? 'border-brand text-brand-deep' : 'border-transparent text-ink-quiet hover:text-heading'}`}
                >
                  <span
                    className={`inline-flex size-5 items-center justify-center rounded-full text-[11px] ${active ? 'bg-brand-wash text-brand-deep' : 'bg-sunken text-ink-quiet'}`}
                  >
                    {f.n(tab.stage)}
                  </span>
                  {tab.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      {notice === undefined ? null : (
        <div
          role="status"
          className="flex items-center gap-2 rounded-card border border-positive/30 bg-positive-wash px-4 py-3 text-[14px] text-positive"
        >
          <Icon name="check-circle" size={18} />
          {f.t(notice.en, notice.ar)}
        </div>
      )}
      {refusal === undefined ? null : (
        <ControlRejection
          control={refusal.control}
          explanation={refusal.explanation}
          controlLabel={f.t('Control', 'الضابط')}
        />
      )}

      {children}
    </div>
  );
}
