/**
 * The Shariah audit workspace (Wasl W6c; BR-F05, SH-18): where a Board
 * member or Shariah auditor finds transactions to examine — by search, or by
 * a sample that anyone can draw again with the same seed — and opens each one's
 * replay. Read-only by construction: the workspace changes nothing.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_INPUT } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { civilDateOf } from '@sanad/origination/civil-date.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import {
  type AuditListing,
  type AuditQuery,
  sampleTransactions,
  searchTransactions,
} from '@sanad/origination/wasl/audit.ts';

import { permits, refusalWording } from '../../../../server/authority.ts';
import { pageStaff } from '../../../../server/session.ts';
import { STATE_LABEL } from '../../transactions/states.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AuditWorkspacePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | undefined>>>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const q = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;
  const allowed = permits(staff, 'SHARIAH_AUDIT_READ');
  if (!allowed.allowed)
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-display font-bold tracking-tight text-heading">
          {t('Shariah audit workspace', 'مساحة التدقيق الشرعي')}
        </h1>
        <p className="text-[14px] text-ink-quiet">{refusalWording(allowed.needs, arabic)}</p>
      </div>
    );

  const numerals = defaultNumerals(locale);
  const query: AuditQuery = {
    ...(q['text'] === undefined ? {} : { text: q['text'].slice(0, 100) }),
    ...(q['from'] !== undefined && DATE.test(q['from']) ? { from: q['from'] } : {}),
    ...(q['to'] !== undefined && DATE.test(q['to']) ? { to: q['to'] } : {}),
    executedOnly: q['executed'] === 'on',
  };
  const today = civilDateOf(tenant, hostClockInstant());
  const sampling = q['sample'] !== undefined;
  const seed = (q['seed'] ?? '').trim().slice(0, 64) || today;
  const size = Math.max(1, Math.min(100, Number.parseInt(q['size'] ?? '10', 10) || 10));
  const sample = sampling ? await sampleTransactions(tenant, query, seed, size) : undefined;
  const rows: readonly AuditListing[] = sample?.chosen ?? (await searchTransactions(tenant, query));

  return (
    <div className="flex flex-col gap-6" data-audit-workspace>
      <div>
        <h1 className="text-display font-bold tracking-tight text-heading">
          {t('Shariah audit workspace', 'مساحة التدقيق الشرعي')}
        </h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            'Find any transaction, or draw a sample, and replay it: each contract in its order with its time, the evidence behind each step, the time the goods were held at the institution’s risk, the figures disclosed, and the approval it was made under. Nothing here changes anything.',
            'ابحث عن أي معاملة أو اسحب عيّنة، واستعرضها: كل عقد بترتيبه ووقته، والبيّنة وراء كل مرحلة، والمدة التي بقيت فيها البضاعة في ضمان المؤسسة، والأرقام المُفصح عنها، والاعتماد الذي تمت بموجبه. لا شيء هنا يغيّر شيئاً.',
          )}
        </p>
      </div>

      <form
        className="grid gap-3 rounded-card border border-line bg-surface px-5 py-4 shadow-card sm:grid-cols-4"
        data-audit-search
      >
        <label className="grid gap-1 text-[13px] sm:col-span-2">
          {t('Transaction, distributor or programme', 'المعاملة أو الموزع أو البرنامج')}
          <input name="text" defaultValue={q['text'] ?? ''} className={FIELD_INPUT} />
        </label>
        <label className="grid gap-1 text-[13px]">
          {t('Opened from', 'فُتحت من')}
          <input type="date" name="from" defaultValue={query.from ?? ''} className={FIELD_INPUT} dir="ltr" />
        </label>
        <label className="grid gap-1 text-[13px]">
          {t('to', 'إلى')}
          <input type="date" name="to" defaultValue={query.to ?? ''} className={FIELD_INPUT} dir="ltr" />
        </label>
        <label className="flex items-center gap-2 text-[13px] sm:col-span-4">
          <input type="checkbox" name="executed" defaultChecked={query.executedOnly === true} />
          {t('Executed sales only', 'البيوع المنفّذة فقط')}
        </label>
        <div className="flex flex-wrap items-end gap-3 sm:col-span-4">
          <button type="submit" className={BUTTON_PRIMARY}>
            {t('Search', 'بحث')}
          </button>
          <span className="text-[13px] text-ink-quiet">{t('or draw a sample of', 'أو اسحب عيّنة من')}</span>
          <input
            name="size"
            defaultValue={String(size)}
            inputMode="numeric"
            className={`${FIELD_INPUT} w-20`}
            dir="ltr"
            aria-label={t('Sample size', 'حجم العيّنة')}
          />
          <label className="grid gap-1 text-[13px]">
            {t('with the seed', 'بالبذرة')}
            <input name="seed" defaultValue={seed} maxLength={64} className={FIELD_INPUT} dir="ltr" />
          </label>
          <button type="submit" name="sample" value="1" className={BUTTON_SECONDARY} data-audit-sample>
            {t('Draw the sample', 'سحب العيّنة')}
          </button>
        </div>
      </form>

      {sample === undefined ? null : (
        <p
          className="rounded-card border border-line bg-surface px-4 py-3 text-[13px] shadow-card"
          data-audit-sample-note
        >
          {t(
            `A sample of ${String(sample.chosen.length)} from ${String(sample.population)} transactions, drawn with the seed “${sample.seed}”. The same seed over the same search draws the same transactions, so the Board can draw it again and check.`,
            `عيّنة من ${String(sample.chosen.length)} من أصل ${String(sample.population)} معاملة، سُحبت بالبذرة «${sample.seed}». البذرة نفسها على البحث نفسه تسحب المعاملات نفسها، فيمكن للهيئة إعادة السحب والتحقق.`,
          )}
        </p>
      )}

      <section className="overflow-x-auto rounded-card border border-line bg-surface shadow-card" data-audit-results>
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-[14px] text-ink-quiet">
            {t('No transaction matches.', 'لا توجد معاملة مطابقة.')}
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-ink-quiet">
                <th className="px-4 py-2 text-start font-normal">{t('Transaction', 'المعاملة')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Distributor', 'الموزع')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Where it stands', 'الوضع')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Opened', 'فُتحت')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Executed', 'نُفّذت')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('Sale price', 'ثمن البيع')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.transactionRef} className="border-t border-line">
                  <td className="px-4 py-2">
                    <Link
                      href={`/${segment}/shariah/audit/${r.transactionRef}`}
                      className="identifier text-brand hover:underline"
                    >
                      {r.transactionRef}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{r.counterpartyId}</td>
                  <td className="px-4 py-2">
                    {t(STATE_LABEL[r.state]?.en ?? r.state, STATE_LABEL[r.state]?.ar ?? r.state)}
                  </td>
                  <td className="px-4 py-2">
                    <bdi className="identifier">{r.openedOn}</bdi>
                  </td>
                  <td className="px-4 py-2">
                    <bdi className="identifier">{r.executedOn ?? '—'}</bdi>
                  </td>
                  <td className="px-4 py-2 text-end">
                    <bdi className="tabular-nums">
                      {formatMinorUnits({ minorUnits: r.salePriceMinor, currency: r.currency as 'SAR' }, numerals)}{' '}
                      {r.currency}
                    </bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
