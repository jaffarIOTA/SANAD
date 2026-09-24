/**
 * The journey's steps, shown in order.
 *
 * The order is the Shariah structure, not a form layout: trade, then terms,
 * then review. A journey that started at an amount would be a loan with extra
 * steps; this one starts at the goods.
 */

import type { ReactElement } from 'react';

import { Icon } from '@sanad/design/icons.tsx';

export type Step = 'trade' | 'terms' | 'review';

const ORDER: readonly Step[] = ['trade', 'terms', 'review'];

const LABEL: Readonly<Record<Step, { en: string; ar: string }>> = {
  trade: { en: 'The trade', ar: 'الصفقة' },
  terms: { en: 'The terms', ar: 'الشروط' },
  review: { en: 'Review & submit', ar: 'المراجعة والإرسال' },
};

export function Steps({ current, arabic }: { readonly current: Step; readonly arabic: boolean }): ReactElement {
  const at = ORDER.indexOf(current);

  return (
    <ol className="flex list-none flex-wrap items-center gap-2 p-0 text-sm" aria-label={arabic ? 'خطوات الطلب' : 'Request steps'}>
      {ORDER.map((step, i) => {
        const done = i < at;
        const active = i === at;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              aria-current={active ? 'step' : undefined}
              className={`inline-flex min-h-tap items-center gap-2 rounded-card border px-3 ${
                active
                  ? 'border-brand-strong bg-brand-wash font-semibold text-brand-deep'
                  : done
                    ? 'border-line bg-surface text-ink'
                    : 'border-line bg-surface text-ink-quiet'
              }`}
            >
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-sunken text-xs tabular-nums">
                {done ? <Icon name="check-circle" size={14} /> : i + 1}
              </span>
              {arabic ? LABEL[step].ar : LABEL[step].en}
            </span>
            {i < ORDER.length - 1 ? <span aria-hidden className="text-ink-quiet">›</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
