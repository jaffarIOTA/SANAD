/**
 * The journey's steps, shown in order, in the kit's tab-strip form.
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
    <nav aria-label={arabic ? 'خطوات الطلب' : 'Request steps'} className="border-b border-line">
      <ol className="flex list-none flex-wrap gap-x-8 gap-y-1 p-0">
        {ORDER.map((step, i) => {
          const done = i < at;
          const active = i === at;
          return (
            <li key={step} className="relative">
              <span
                aria-current={active ? 'step' : undefined}
                className={`inline-flex min-h-tap items-center gap-3 pb-3 text-[16px] ${active ? 'font-medium text-brand-deep' : done ? 'text-ink' : 'text-ink-quiet'}`}
              >
                <span
                  aria-hidden
                  className={`inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                    active ? 'bg-brand-deep text-white' : done ? 'bg-disc-teal text-positive' : 'bg-sunken text-ink-quiet'
                  }`}
                >
                  {done ? <Icon name="check-circle" size={14} /> : i + 1}
                </span>
                {arabic ? LABEL[step].ar : LABEL[step].en}
              </span>
              {active ? <span aria-hidden className="nav-indicator absolute inset-x-0 bottom-0 h-[3px] rounded-t-full bg-brand-deep" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
