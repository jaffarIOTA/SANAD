/**
 * One Murabaha transaction: where it stands in the sequence, its fixed
 * figures (cost, profit, sale price — a profit amount, never a rate), its
 * structure and the board approval it runs under, the trade it finances, the
 * three gates as the sequencing engine evaluates them, its legs, and its
 * event log. Another institution's transaction is not found.
 */
import { notFound } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import { arabicIndic } from '@sanad/core/documents/offer-letter.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { ummAlQura } from '../../../../server/hijri.ts';
import { getTransaction } from '../../../../server/murabaha-transactions.ts';
import { pageStaff } from '../../../../server/session.ts';
import { GATE_LABEL, GATE_STATUS, SEQUENCE, STATE_LABEL } from '../states.ts';

export default async function TransactionPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string; readonly transactionRef: string }>;
}) {
  const { locale: segment, transactionRef } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const n = (s: string): string => (arabic ? arabicIndic(s) : s);
  const numerals = defaultNumerals(locale);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined || !/^WT-\d{6,10}$/.test(transactionRef)) notFound();
  const v = await getTransaction(staff.tenantId as TenantCode, transactionRef);
  if (v === undefined) notFound();
  const core = v.transaction.core;
  const p = core.pricing;
  const at = SEQUENCE.indexOf(v.transaction.state);
  const label = (s: string) => {
    const l = STATE_LABEL[s];
    return l === undefined ? s : t(l.en, l.ar);
  };
  const hours = Math.floor(core.riskPeriodRequiredSeconds / 3600);
  const minutes = Math.floor((core.riskPeriodRequiredSeconds % 3600) / 60);
  const legs = 'legs' in v.transaction ? v.transaction.legs : [];

  const Row = ({ k, children }: { readonly k: string; readonly children: React.ReactNode }) => (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-line py-2 last:border-b-0">
      <dt className="text-[13px] text-ink-quiet">{k}</dt>
      <dd className="text-[14px] font-medium text-heading">{children}</dd>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[13px] text-ink-quiet">
            <a href={`/${segment}/transactions`} className="hover:underline">
              {t('Transactions', 'المعاملات')}
            </a>{' '}
            /
          </p>
          <h1 className="identifier text-display font-bold tracking-tight text-heading">{v.transactionRef}</h1>
          <p className="mt-1 text-[14px] text-ink-quiet">
            {core.counterpartyId} · {t('opened from request ', 'فُتحت من الطلب ')}
            <a href={`/${segment}/requests/${v.requestRef}`} className="identifier text-brand hover:underline">
              {v.requestRef}
            </a>
          </p>
        </div>
        <span className="rounded-full border border-brand/40 bg-brand-wash px-3 py-1 text-[13px] font-semibold text-brand">
          {label(v.transaction.state)}
        </span>
      </div>

      {/* The sequence, in order: nothing reaches the sale without passing every step before it. */}
      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-sequence>
        <h2 className="mb-3 text-[15px] font-semibold text-heading">{t('Sequence', 'التسلسل')}</h2>
        <ol className="flex flex-wrap gap-2">
          {SEQUENCE.map((s, i) => (
            <li
              key={s}
              aria-current={i === at ? 'step' : undefined}
              className={`rounded-full border px-3 py-1 text-[12px] ${
                i === at
                  ? 'border-brand bg-brand text-on-brand'
                  : i < at
                    ? 'border-line-strong text-heading'
                    : 'border-line text-ink-faint'
              }`}
            >
              {n(String(i + 1))}. {label(s)}
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-figures>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Figures', 'الأرقام')}</h2>
          <dl>
            <Row k={t('Cost of goods', 'تكلفة البضاعة')}>{formatMinorUnits(p.costAmount, numerals)}</Row>
            <Row k={t('Profit', 'الربح')}>{formatMinorUnits(p.profitAmount, numerals)}</Row>
            <Row k={t('Sale price (fixed)', 'ثمن البيع (ثابت)')}>{formatMinorUnits(p.salePriceAmount, numerals)}</Row>
            <Row k={t('Tenor', 'المدة')}>{t(`${core.tenorDays} days`, `${n(String(core.tenorDays))} يوماً`)}</Row>
            <Row k={t('Maturity', 'الاستحقاق')}>
              <bdi>{n(core.maturityDateGregorian)}</bdi> · <bdi>{ummAlQura(core.maturityDateGregorian)}</bdi>
            </Row>
          </dl>
          <p className="mt-2 text-[12px] text-ink-quiet">
            {t(
              'A profit amount fixed at opening: the sale price never increases, and late amounts go to charity, never income.',
              'ربح بمبلغ ثابت عند الفتح: لا يزيد ثمن البيع أبداً، وتذهب مبالغ التأخير إلى الخير لا إلى الدخل.',
            )}
          </p>
        </section>

        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-structure>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Structure and board', 'الهيكل والهيئة')}</h2>
          <dl>
            <Row k={t('Structure', 'الهيكل')}>
              <span className="identifier">
                {core.structureDefinitionId} v{core.structureVersion}
              </span>
            </Row>
            <Row k={t('Board approval', 'موافقة الهيئة')}>
              <span className="identifier">{core.shariahApprovalId}</span>
            </Row>
            <Row k={t('Risk-holding interval (snapshotted)', 'مدة تحمّل المخاطر (مثبّتة)')}>
              {t(`${hours} h ${minutes} min`, `${n(String(hours))} س ${n(String(minutes))} د`)}
            </Row>
            <Row k={t('Programme', 'البرنامج')}>
              <span className="identifier">{core.programmeId}</span>
            </Row>
            <Row k={t('Credit policy', 'سياسة الائتمان')}>
              <span className="identifier">{core.creditPolicyVersion}</span>
            </Row>
          </dl>
        </section>
      </div>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-gates>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Gates', 'البوابات')}</h2>
        <ul className="divide-y divide-line">
          {v.gates.gates.map((g) => {
            const gl = GATE_LABEL[g.gateId];
            const gs = GATE_STATUS[g.status];
            return (
              <li key={g.gateId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-[14px] text-heading">{gl === undefined ? g.gateId : t(gl.en, gl.ar)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[12px] ${
                    g.status === 'SATISFIED' ? 'bg-positive-wash text-positive' : 'border border-line text-ink-quiet'
                  }`}
                >
                  {gs === undefined ? g.status : t(gs.en, gs.ar)}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t(
            'Evaluated by the sequencing engine from the transaction’s legs and evidence. No role can pass a gate that is not satisfied.',
            'يقيّمها محرك التسلسل من أطراف العقد والأدلة. لا يملك أي دور تجاوز بوابة غير مستوفاة.',
          )}
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-trade>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Trade financed', 'التجارة الممولة')}</h2>
          <dl>
            <Row k={t('Cleared invoice', 'الفاتورة المعتمدة')}>
              <span className="identifier text-[12px]">{core.tradeReference.invoiceUuid ?? '—'}</span>
            </Row>
            <Row k={t('Issuer CR', 'سجل المُصدِر')}>
              <span className="identifier">{core.tradeReference.issuerCr}</span>
            </Row>
            <Row k={t('Recipient CR', 'سجل المستلم')}>
              <span className="identifier">{core.tradeReference.recipientCr}</span>
            </Row>
          </dl>
        </section>
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-legs>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Contract legs', 'أطراف العقد')}</h2>
          {legs.length === 0 ? (
            <p className="text-[13px] text-ink-quiet">
              {t(
                'None yet. Each leg — the wa’d, the purchase, the sale offer, the acceptance — is its own document, timestamped and chained to the one before.',
                'لا يوجد بعد. كل طرف — الوعد والشراء وعرض البيع والقبول — مستند مستقل مختوم زمنياً ومتسلسل مع ما قبله.',
              )}
            </p>
          ) : (
            <ol className="flex flex-col gap-1 text-[13px]">
              {legs.map((l) => (
                <li key={l.legId} className="identifier">
                  {n(String(l.sequenceNo))}. {l.legType}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-events>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Event log', 'سجل الأحداث')}</h2>
        <ol className="flex flex-col gap-1 text-[13px]">
          {v.events.map((e, i) => (
            <li key={`${e.eventType}-${String(i)}`} className="flex flex-wrap gap-x-3">
              <span className="identifier text-ink-quiet">
                {new Date(Number(e.occurredAtEpochSeconds) * 1000).toISOString().slice(0, 16).replace('T', ' ')}
              </span>
              <span className="font-medium text-heading">{e.eventType}</span>
              {e.toState === null ? null : <span className="text-ink-quiet">→ {label(e.toState)}</span>}
              <span className="identifier text-ink-quiet">{e.actor}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
