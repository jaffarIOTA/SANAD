/**
 * Chart pieces.
 *
 * Inline SVG and plain markup. No charting library — three forms is not worth
 * a dependency, and a bank's supply-chain review will ask about every one of
 * them (SDD §6.12).
 *
 * Rules these follow, because they are easy to lose:
 *
 *   - **Text wears text tokens, never the series colour.** A coloured mark
 *     beside a label carries identity; the label itself stays in ink.
 *   - **Never colour alone.** Every segment has a legend entry with its label
 *     and its number, which doubles as the table view.
 *   - **A 2px surface gap between adjacent fills**, so touching segments read
 *     as separate marks rather than one band.
 *   - **Rounded data-ends**, square where a segment continues.
 *   - The ordinal ramp is one hue with monotone lightness, validated against
 *     this product's own surfaces. It encodes *stages of one thing*. It is not
 *     a categorical palette and must not be used to tell unrelated series
 *     apart.
 */

import type { ReactElement } from 'react';

import { IconChip, type IconName } from './icons.tsx';

export interface Segment {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  /** A `--color-stage-*` token, or a status token where the meaning is status. */
  readonly colour: string;
}

// -- Stat tile ----------------------------------------------------------------

/**
 * A headline number. Not a chart, and deliberately so: one number is read
 * faster as a number than as any mark you could draw around it.
 */
export function StatTile({
  label,
  value,
  unit,
  icon,
  tone = 'brand',
  context,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly icon: IconName;
  readonly tone?: 'brand' | 'positive' | 'attention' | 'neutral';
  /**
   * The small chip the reference dashboards use for a period-on-period delta.
   * Ours carries a real, current fact instead — we have no history to compare
   * against yet, and a fabricated "+8.5%" on an operations screen is a lie
   * with a percent sign on it.
   */
  readonly context?: string;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <div
      className={`rounded-card border bg-surface p-4 ${
        emphasis ? 'border-brand-strong' : 'border-line'
      }`}
    >
      <div className="flex items-start gap-3">
        <IconChip name={icon} tone={tone} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm text-ink-quiet">{label}</span>
            {context !== undefined ? (
              <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[0.6875rem] text-ink-quiet tabular-nums">
                {context}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-amount font-semibold leading-tight text-ink tabular-nums">
            <bdi>{value}</bdi>
            {unit !== undefined ? (
              <span className="ms-1 text-sm font-normal text-ink-quiet">{unit}</span>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}

// -- Stacked proportion bar ---------------------------------------------------

/**
 * One bar, split by stage, with the legend carrying every label and count.
 *
 * Chosen over a donut on purpose: comparing arc lengths is harder than
 * comparing bar lengths, and a donut spends its middle on nothing.
 */
export function StageBar({
  title,
  segments,
  emptyLabel,
}: {
  readonly title: string;
  readonly segments: readonly Segment[];
  readonly emptyLabel: string;
}): ReactElement {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const present = segments.filter((s) => s.value > 0);

  return (
    <figure className="m-0 flex flex-col gap-3">
      <figcaption className="text-sm font-medium text-ink">{title}</figcaption>

      {total === 0 ? (
        <p className="text-sm text-ink-quiet">{emptyLabel}</p>
      ) : (
        <>
          <svg
            viewBox="0 0 100 6"
            preserveAspectRatio="none"
            className="h-3 w-full"
            role="img"
            aria-label={`${title}: ${present.map((s) => `${s.label} ${String(s.value)}`).join(', ')}`}
          >
            {(() => {
              let x = 0;
              return present.map((s, i) => {
                const width = (s.value / total) * 100;
                // A 2px surface gap between fills, expressed in the viewBox's
                // units so it survives the non-uniform scale.
                const gap = i === present.length - 1 ? 0 : 0.6;
                const rect = (
                  <rect
                    key={s.id}
                    x={x}
                    y={0}
                    width={Math.max(width - gap, 0.4)}
                    height={6}
                    rx={1}
                    fill={`var(${s.colour})`}
                  >
                    <title>{`${s.label}: ${String(s.value)}`}</title>
                  </rect>
                );
                x += width;
                return rect;
              });
            })()}
          </svg>

          {/* The legend is also the table view: every label, every number. */}
          <ul className="flex list-none flex-col gap-1 p-0">
            {segments.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: `var(${s.colour})` }}
                />
                <span className="text-ink-quiet">{s.label}</span>
                <span className="ms-auto tabular-nums text-ink">{s.value}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}

// -- Horizontal bars ----------------------------------------------------------

/**
 * A single series of magnitudes by category. One hue, so no legend — the
 * title names the series — and every bar is directly labelled with its value.
 */
export function BarList({
  title,
  rows,
  emptyLabel,
}: {
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly value: number }[];
  readonly emptyLabel: string;
}): ReactElement {
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);

  return (
    <figure className="m-0 flex flex-col gap-3">
      <figcaption className="text-sm font-medium text-ink">{title}</figcaption>

      {max === 0 ? (
        <p className="text-sm text-ink-quiet">{emptyLabel}</p>
      ) : (
        <ul className="flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-3 text-sm">
              <span className="w-40 shrink-0 text-ink-quiet">{r.label}</span>
              <span className="flex h-2 min-w-0 flex-1 items-center">
                <span
                  className="h-2 rounded-full bg-brand-strong"
                  style={{ inlineSize: `${String(Math.max((r.value / max) * 100, 2))}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-end tabular-nums text-ink">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

// -- Indicator rows -----------------------------------------------------------

export type IndicatorTone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

const INDICATOR: Record<
  IndicatorTone,
  { readonly dot: string; readonly text: string; readonly pill: string }
> = {
  good: { dot: 'bg-positive', text: 'text-positive', pill: 'bg-sunken' },
  warning: { dot: 'bg-attention', text: 'text-attention', pill: 'bg-brand-wash' },
  serious: { dot: 'bg-attention', text: 'text-attention', pill: 'bg-brand-wash' },
  critical: { dot: 'bg-blocked', text: 'text-blocked', pill: 'bg-blocked-wash' },
  neutral: { dot: 'bg-line-strong', text: 'text-ink-quiet', pill: 'bg-sunken' },
};

/**
 * A measured value with a state.
 *
 * Status colour never carries the meaning by itself — every row has its label
 * and its number, and the colour is a third channel on top.
 */
export function Indicator({
  label,
  value,
  tone,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: IndicatorTone;
  readonly note?: string;
}): ReactElement {
  const style = INDICATOR[tone];
  return (
    <li className={`flex items-start gap-2 rounded-card px-3 py-2 ${style.pill}`}>
      <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-ink">{label}</span>
        {note !== undefined ? <span className="text-xs text-ink-quiet">{note}</span> : null}
      </span>
      <span className={`ms-auto shrink-0 text-sm font-semibold tabular-nums ${style.text}`}>
        {value}
      </span>
    </li>
  );
}

// =============================================================================
// Figma dashboard charts (BankDash kit, 2026-09-26). Inline SVG, no library.
//
// Colours are the design's own and are fixed; identity is never colour alone —
// each chart carries a legend or direct labels and every mark a <title>, and
// the pie is followed by its own table. Geometry is drawn LTR inside the SVG
// (a time axis reads left to right in Arabic too); everything around it uses
// logical properties.
// =============================================================================

export interface PairedBar {
  readonly label: string;
  readonly first: number;
  readonly second: number;
}

/** Weekly activity: two thin rounded bars per day, gridlines behind, axis at the start. */
export function WeekBars({
  title,
  series,
  bars,
  emptyLabel,
}: {
  readonly title: string;
  readonly series: readonly [string, string];
  readonly bars: readonly PairedBar[];
  readonly emptyLabel: string;
}): ReactElement {
  const W = 640;
  const H = 226;
  const padStart = 40;
  const padBottom = 26;
  const plotH = H - padBottom - 8;
  const max = Math.max(1, ...bars.flatMap((b) => [b.first, b.second]));
  const step = Math.max(1, Math.ceil(max / 5));
  const top = step * 5;
  const y = (v: number) => 8 + plotH - (v / top) * plotH;
  const slot = (W - padStart) / Math.max(1, bars.length);
  const total = bars.reduce((s, b) => s + b.first + b.second, 0);

  return (
    <figure className="m-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <figcaption className="sr-only">{title}</figcaption>
        <span aria-hidden className="text-sm text-ink-quiet">{title}</span>
        <ul className="ms-auto flex list-none gap-5 p-0 text-[15px] text-ink-quiet">
          {series.map((name, i) => (
            <li key={name} className="flex items-center gap-2">
              <span aria-hidden className="inline-block size-[15px] rounded-full" style={{ background: i === 0 ? 'var(--color-series-1)' : 'var(--color-series-2)' }} />
              {name}
            </li>
          ))}
        </ul>
      </div>
      {total === 0 ? (
        <p className="mt-6 text-sm text-ink-quiet">{emptyLabel}</p>
      ) : (
        <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="mt-3 h-auto w-full" role="img" aria-label={title}>
          {Array.from({ length: 6 }, (_, i) => {
            const v = i * step;
            return (
              <g key={v}>
                <line x1={padStart} x2={W} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeWidth={1} />
                <text x={padStart - 10} y={y(v) + 4} textAnchor="end" fontSize={13} fill="var(--color-ink-quiet)">{v}</text>
              </g>
            );
          })}
          {bars.map((b, i) => {
            const cx = padStart + slot * i + slot / 2;
            const first = { x: cx - 21, h: Math.max(0, y(0) - y(b.first)) };
            const second = { x: cx + 6, h: Math.max(0, y(0) - y(b.second)) };
            return (
              <g key={b.label}>
                <rect className="grow-y" style={{ animationDelay: `${String(i * 60)}ms` }} x={first.x} y={y(b.first)} width={15} height={first.h} rx={7.5} fill="var(--color-series-1)">
                  <title>{`${b.label} · ${series[0]}: ${String(b.first)}`}</title>
                </rect>
                <rect className="grow-y" style={{ animationDelay: `${String(i * 60 + 80)}ms` }} x={second.x} y={y(b.second)} width={15} height={second.h} rx={7.5} fill="var(--color-series-2)">
                  <title>{`${b.label} · ${series[1]}: ${String(b.second)}`}</title>
                </rect>
                <text x={cx} y={H - 6} textAnchor="middle" fontSize={13} fill="var(--color-ink-quiet)">{b.label}</text>
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}

export interface Slice {
  readonly label: string;
  readonly value: number;
}

const SLICE_COLOURS = ['var(--color-slice-1)', 'var(--color-slice-2)', 'var(--color-slice-3)', 'var(--color-slice-4)'] as const;

/**
 * The design's exploded pie: at most four slices (a fifth folds into
 * "other"), each labelled with its share, each slightly offset from centre.
 * A table of the same figures follows for anyone the pie does not serve.
 */
export function SharePie({
  title,
  slices,
  otherLabel,
  emptyLabel,
}: {
  readonly title: string;
  readonly slices: readonly Slice[];
  readonly otherLabel: string;
  readonly emptyLabel: string;
}): ReactElement {
  const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const shown = sorted.length > 4 ? [...sorted.slice(0, 3), { label: otherLabel, value: sorted.slice(3).reduce((s, x) => s + x.value, 0) }] : sorted;
  const total = shown.reduce((s, x) => s + x.value, 0);
  const R = 118;
  const C = 150;
  let angle = -Math.PI / 2;
  const arcs = shown.map((s, i) => {
    const share = s.value / total;
    const start = angle;
    const end = angle + share * Math.PI * 2;
    angle = end;
    const mid = (start + end) / 2;
    const offset = 5;
    const dx = Math.cos(mid) * offset;
    const dy = Math.sin(mid) * offset;
    const large = end - start > Math.PI ? 1 : 0;
    const p1 = [C + R * Math.cos(start), C + R * Math.sin(start)];
    const p2 = [C + R * Math.cos(end), C + R * Math.sin(end)];
    const d = share >= 0.999
      ? `M ${String(C)} ${String(C - R)} A ${String(R)} ${String(R)} 0 1 1 ${String(C - 0.01)} ${String(C - R)} Z`
      : `M ${String(C)} ${String(C)} L ${String(p1[0])} ${String(p1[1])} A ${String(R)} ${String(R)} 0 ${String(large)} 1 ${String(p2[0])} ${String(p2[1])} Z`;
    const lx = C + (R * 0.6) * Math.cos(mid) + dx;
    const ly = C + (R * 0.6) * Math.sin(mid) + dy;
    return { ...s, share, d, dx, dy, lx, ly, colour: SLICE_COLOURS[i] ?? SLICE_COLOURS[3] };
  });
  const pct = (share: number) => `${String(Math.round(share * 100))}%`;

  return (
    <figure className="m-0">
      <figcaption className="sr-only">{title}</figcaption>
      {total === 0 ? (
        <p className="text-sm text-ink-quiet">{emptyLabel}</p>
      ) : (
        <>
          <svg viewBox="0 0 300 300" className="mx-auto h-auto w-full max-w-[300px]" role="img" aria-label={title}>
            {arcs.map((a, i) => (
              <g key={a.label} className="slice-in" style={{ animationDelay: `${String(i * 90)}ms` }} transform={`translate(${String(a.dx)} ${String(a.dy)})`}>
                <path d={a.d} fill={a.colour} stroke="var(--color-surface)" strokeWidth={2}>
                  <title>{`${a.label}: ${String(a.value)} (${pct(a.share)})`}</title>
                </path>
                {a.share >= 0.08 ? (
                  <text x={a.lx} y={a.ly} textAnchor="middle" fill="#ffffff" fontWeight={700}>
                    <tspan x={a.lx} dy="-2" fontSize={16}>{pct(a.share)}</tspan>
                    <tspan x={a.lx} dy="16" fontSize={12}>{a.label.length > 14 ? `${a.label.slice(0, 13)}…` : a.label}</tspan>
                  </text>
                ) : null}
              </g>
            ))}
          </svg>
          <ul className="mt-4 flex list-none flex-col gap-1 p-0 text-[13px] text-ink-quiet">
            {arcs.map((a) => (
              <li key={a.label} className="flex items-center gap-2">
                <span aria-hidden className="inline-block size-3 shrink-0 rounded-full" style={{ background: a.colour }} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="tabular-nums text-ink">{a.value}</span>
                <span className="w-10 text-end tabular-nums">{pct(a.share)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}

export interface TrendPoint {
  readonly label: string;
  readonly value: number;
}

/** Balance-history style area: one line, gradient fill, dotted verticals, values on the start axis. */
export function AreaTrend({
  title,
  points,
  unit,
  emptyLabel,
}: {
  readonly title: string;
  readonly points: readonly TrendPoint[];
  readonly unit: string;
  readonly emptyLabel: string;
}): ReactElement {
  const W = 560;
  const H = 210;
  const padStart = 46;
  const padBottom = 24;
  const plotH = H - padBottom - 10;
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = step * 4;
  const y = (v: number) => 10 + plotH - (v / top) * plotH;
  const x = (i: number) => padStart + ((W - padStart - 10) * i) / Math.max(1, points.length - 1);
  const total = points.reduce((s, p) => s + p.value, 0);

  // Smooth the line with Catmull-Rom → cubic Bézier so it reads as the design's curve.
  const pts = points.map((p, i) => [x(i), y(p.value)] as const);
  let d = '';
  pts.forEach(([px, py], i) => {
    if (i === 0) { d += `M ${String(px)} ${String(py)}`; return; }
    const p0 = pts[i - 2] ?? pts[i - 1] ?? [px, py];
    const p1 = pts[i - 1] ?? [px, py];
    const p3 = pts[i + 1] ?? [px, py];
    const c1 = [p1[0] + (px - p0[0]) / 6, p1[1] + (py - p0[1]) / 6];
    const c2 = [px - (p3[0] - p1[0]) / 6, py - (p3[1] - p1[1]) / 6];
    d += ` C ${String(c1[0])} ${String(c1[1])}, ${String(c2[0])} ${String(c2[1])}, ${String(px)} ${String(py)}`;
  });
  const last = pts[pts.length - 1];
  const first = pts[0];
  const area = last !== undefined && first !== undefined ? `${d} L ${String(last[0])} ${String(y(0))} L ${String(first[0])} ${String(y(0))} Z` : '';

  return (
    <figure className="m-0">
      <figcaption className="sr-only">{title}</figcaption>
      {total === 0 || points.length < 2 ? (
        <p className="text-sm text-ink-quiet">{emptyLabel}</p>
      ) : (
        <svg viewBox={`0 0 ${String(W)} ${String(H)}`} className="h-auto w-full" role="img" aria-label={title}>
          <defs>
            <linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--color-area-line)" stopOpacity="0.25" />
              <stop offset="1" stopColor="var(--color-area-line)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {Array.from({ length: 5 }, (_, i) => {
            const v = i * step;
            return (
              <g key={v}>
                <line x1={padStart} x2={W - 10} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray="4 4" />
                <text x={padStart - 10} y={y(v) + 4} textAnchor="end" fontSize={12} fill="var(--color-ink-quiet)">{v}</text>
              </g>
            );
          })}
          {points.map((p, i) => (
            <g key={p.label}>
              <line x1={x(i)} x2={x(i)} y1={10} y2={y(0)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray="4 4" />
              <text x={x(i)} y={H - 6} textAnchor="middle" fontSize={13} fill="var(--color-ink-quiet)">{p.label}</text>
            </g>
          ))}
          <path className="fade-up" d={area} fill="url(#area-fill)" />
          <path className="draw" style={{ ['--draw-length' as string]: '1400' }} d={d} fill="none" stroke="var(--color-area-line)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          {pts.map(([px, py], i) => (
            <circle key={points[i]?.label} cx={px} cy={py} r={9} fill="transparent">
              <title>{`${points[i]?.label ?? ''}: ${String(points[i]?.value ?? 0)} ${unit}`}</title>
            </circle>
          ))}
        </svg>
      )}
    </figure>
  );
}
