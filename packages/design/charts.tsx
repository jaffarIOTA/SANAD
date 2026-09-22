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
  delta,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  /** Rendered with its sign and a word, never as a bare coloured arrow. */
  readonly delta?: { readonly text: string; readonly direction: 'up' | 'down' | 'flat' };
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <div
      className={`rounded-card border bg-surface p-4 ${
        emphasis ? 'border-brand-strong' : 'border-line'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm text-ink-quiet">{label}</span>
        {delta !== undefined ? (
          <span className="rounded-full bg-sunken px-2 py-0.5 text-[0.6875rem] text-ink-quiet tabular-nums">
            {delta.text}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-amount font-semibold text-ink tabular-nums">
        <bdi>{value}</bdi>
        {unit !== undefined ? <span className="ms-1 text-sm text-ink-quiet">{unit}</span> : null}
      </p>
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

const INDICATOR: Record<IndicatorTone, { readonly dot: string; readonly text: string }> = {
  good: { dot: 'bg-positive', text: 'text-positive' },
  warning: { dot: 'bg-attention', text: 'text-attention' },
  serious: { dot: 'bg-attention', text: 'text-attention' },
  critical: { dot: 'bg-blocked', text: 'text-blocked' },
  neutral: { dot: 'bg-line-strong', text: 'text-ink-quiet' },
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
    <li className="flex items-start gap-2 border-b border-line py-2 last:border-b-0">
      <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${style.dot}`} />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-ink">{label}</span>
        {note !== undefined ? <span className="text-xs text-ink-quiet">{note}</span> : null}
      </span>
      <span className={`ms-auto shrink-0 text-sm font-medium tabular-nums ${style.text}`}>
        {value}
      </span>
    </li>
  );
}
