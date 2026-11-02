/**
 * Distributor facilities (Wasl W5a): for each programme, each distributor's
 * facility in force, what it already holds and what is left; every proposal
 * awaiting a second person; and the concentration rules the institution has
 * chosen (set in Admin, under four eyes). No facility, no trade.
 *
 * A courtesy view of what facilities.ts and exposure.ts derive. The acts are
 * refused by the service where they do not apply: a proposer deciding their
 * own proposal, a facility above its programme, an approval below what is held.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_INPUT, FIELD_TEXTAREA } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { hydrate, waslPool } from '@sanad/origination/wasl/book.ts';
import { resolveConcentration } from '@sanad/origination/wasl/concentration.ts';
import { resolveWaslParties } from '@sanad/origination/wasl/configuration.ts';
import { exposureOf } from '@sanad/origination/wasl/exposure.ts';
import { facilitiesFrom, facilityApprovals } from '@sanad/origination/wasl/facilities.ts';

import { pageStaff } from '../../../server/session.ts';
import { decideFacilityAction, proposeFacilityAction } from '../../../server/transaction-actions.ts';
import { Gate } from '../Gate.tsx';
import { NOTICE, REFUSAL } from '../transactions/states.ts';

export default async function FacilitiesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly notice?: string; readonly reason?: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const { notice, reason } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;
  const parties = await resolveWaslParties(tenant);
  const said = notice === undefined ? undefined : NOTICE[notice];
  const refused = reason === undefined ? undefined : (REFUSAL[reason] ?? { en: reason, ar: reason });
  const amount = (minorUnits: bigint) => (
    <bdi className="tabular-nums">{formatMinorUnits({ minorUnits, currency: 'SAR' }, numerals)} SAR</bdi>
  );

  if (!parties.ok)
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-display font-bold tracking-tight text-heading">{t('Facilities', 'التسهيلات')}</h1>
        <p className="text-[14px] text-ink-quiet">
          {t('No Wasl programme is configured for this institution.', 'لا يوجد برنامج وصل مُعدّ لهذه المؤسسة.')}
        </p>
      </div>
    );

  const approvals = await facilityApprovals(tenant);
  const facilities = facilitiesFrom(approvals);
  const book = [...(await hydrate(tenant)).records.values()];
  const policy = await resolveConcentration(waslPool(), tenant, hostClockInstant().epochSeconds);
  // Per ten thousand, shown as a percentage in whole numbers: 2500 → 25.00%.
  const share = (n: number) => `${String(Math.floor(n / 100))}.${String(n % 100).padStart(2, '0')}%`;
  const pending = approvals.filter((a) => a.state === 'PROPOSED');
  const decided = approvals
    .filter((a) => a.state !== 'PROPOSED')
    .slice(-10)
    .reverse();
  const nameOf = (counterpartyId: string) => {
    const d = parties.value.distributors.find((x) => x.counterpartyId === counterpartyId);
    return d === undefined ? counterpartyId : t(d.nameEn, d.nameAr);
  };
  const programmeName = (id: string) => {
    const p = parties.value.programmes.find((x) => x.programmeId === id);
    return p === undefined ? id : t(p.nameEn, p.nameAr);
  };

  return (
    <div className="flex flex-col gap-6" data-facilities>
      <div>
        <h1 className="text-display font-bold tracking-tight text-heading">{t('Facilities', 'التسهيلات')}</h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            'A distributor draws under a programme only within a facility: proposed by credit, approved by a different person. A trade’s cost is held against the facility, then the programme, then the concentration rules the institution has chosen; the first it does not fit refuses it and nothing is held.',
            'لا يسحب الموزع ضمن برنامج إلا في حدود تسهيل يقترحه الائتمان ويعتمده شخص آخر. تُحجز تكلفة الصفقة من التسهيل ثم من البرنامج ثم وفق قواعد التركّز التي اختارتها المؤسسة؛ وأول حد لا تتسع له يرفضها ولا يُحجز شيء.',
          )}
        </p>
      </div>

      {said === undefined ? null : (
        <p className="rounded-card border border-positive/30 bg-positive-wash px-4 py-3 text-[14px] text-positive">
          {t(said.en, said.ar)}
        </p>
      )}
      {refused === undefined ? null : (
        <p className="rounded-card border border-blocked/30 bg-blocked-wash px-4 py-3 text-[14px] text-blocked">
          {t(refused.en, refused.ar)}
        </p>
      )}

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-concentration>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Concentration rules', 'قواعد التركّز')}</h2>
        {policy.ok ? (
          <ul className="space-y-1 text-[13px]">
            <li>
              {t('Single-trade cap', 'الحد الأقصى للصفقة الواحدة')}:{' '}
              {policy.value.singleTradeCap.enabled
                ? amount(policy.value.singleTradeCap.maxCostMinorUnits)
                : t('not applied', 'غير مطبّق')}
            </li>
            <li>
              {t('Distributor’s share of its programme', 'نصيب الموزع من برنامجه')}:{' '}
              {policy.value.distributorShareOfProgramme.enabled
                ? share(policy.value.distributorShareOfProgramme.maxSharePerTenThousand)
                : t('not applied', 'غير مطبّق')}
            </li>
            <li>
              {t('Anchor’s share of the book', 'نصيب الجهة الراعية من المحفظة')}:{' '}
              {policy.value.anchorShareOfBook.enabled
                ? share(policy.value.anchorShareOfBook.maxSharePerTenThousand)
                : t('not applied', 'غير مطبّق')}
            </li>
            <li className="identifier text-[12px] text-ink-quiet">{policy.value.policyRef}</li>
          </ul>
        ) : (
          <p className="text-[13px] text-blocked">
            {t('The concentration policy does not load.', 'لا يمكن تحميل سياسة التركّز.')}
          </p>
        )}
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t(
            'Chosen by the institution in Admin → Concentration, by one administrator and approved by another.',
            'تختارها المؤسسة في الإدارة ← التركّز، ويقترحها مسؤول ويعتمدها آخر.',
          )}
        </p>
      </section>

      {parties.value.programmes.map((p) => (
        <section
          key={p.programmeId}
          className="overflow-x-auto rounded-card border border-line bg-surface shadow-card"
          data-programme={p.programmeId}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
            <h2 className="text-[15px] font-semibold text-heading">{t(p.nameEn, p.nameAr)}</h2>
            <span className="text-[13px] text-ink-quiet">
              {t('Programme limit', 'حد البرنامج')} {amount(p.programmeLimitMinorUnits)} · {t('held', 'المحجوز')}{' '}
              {amount(exposureOf(book, parties.value, '', p.programmeId).programmeHeld)}
            </span>
          </div>
          <table className="mt-2 w-full text-[13px]">
            <thead>
              <tr className="text-ink-quiet">
                <th className="px-5 py-2 text-start font-normal">{t('Distributor', 'الموزع')}</th>
                <th className="px-3 py-2 text-end font-normal">{t('Facility', 'التسهيل')}</th>
                <th className="px-3 py-2 text-end font-normal">{t('Held', 'المحجوز')}</th>
                <th className="px-5 py-2 text-end font-normal">{t('Available', 'المتاح')}</th>
              </tr>
            </thead>
            <tbody>
              {parties.value.distributors.map((d) => {
                const f = facilities.find(
                  (x) => x.counterpartyId === d.counterpartyId && x.programmeId === p.programmeId,
                );
                const held = exposureOf(book, parties.value, d.counterpartyId, p.programmeId).facilityHeld;
                return (
                  <tr key={d.counterpartyId} className="border-t border-line">
                    <td className="px-5 py-2">{t(d.nameEn, d.nameAr)}</td>
                    <td className="px-3 py-2 text-end">
                      {f === undefined ? (
                        <span className="text-ink-quiet">{t('None', 'لا يوجد')}</span>
                      ) : (
                        amount(f.limit.minorUnits)
                      )}
                    </td>
                    <td className="px-3 py-2 text-end">{amount(held)}</td>
                    <td className="px-5 py-2 text-end font-medium text-heading">
                      {f === undefined ? '—' : amount(f.limit.minorUnits > held ? f.limit.minorUnits - held : 0n)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-facility-pending>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Awaiting a decision', 'بانتظار القرار')}</h2>
        {pending.length === 0 ? (
          <p className="text-[13px] text-ink-quiet">
            {t('No proposal awaits a decision.', 'لا يوجد اقتراح بانتظار القرار.')}
          </p>
        ) : (
          <ul className="divide-y divide-line text-[13px]">
            {pending.map((a) => (
              <li key={a.approvalId} className="space-y-2 py-3">
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <span className="font-medium text-heading">{nameOf(a.counterpartyId)}</span>
                  <span className="text-ink-quiet">{programmeName(a.programmeId)}</span>
                  <span className="font-medium text-heading">{amount(a.limit.minorUnits)}</span>
                  <span className="text-ink-quiet">
                    {t('proposed by', 'اقترحه')} {a.proposedBy}
                  </span>
                </div>
                <p className="text-ink">“{a.rationale}”</p>
                <Gate staff={staff} act="FACILITY_APPROVE" arabic={arabic} ownWork={a.proposedBy === staff.principalId}>
                  <div className="flex flex-wrap items-start gap-3">
                    <form action={decideFacilityAction}>
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="approvalId" value={a.approvalId} />
                      <input type="hidden" name="decision" value="APPROVE" />
                      <button type="submit" className={BUTTON_PRIMARY} data-facility-approve>
                        {t('Approve', 'اعتماد')}
                      </button>
                    </form>
                    <form action={decideFacilityAction} className="flex flex-wrap items-start gap-2">
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="approvalId" value={a.approvalId} />
                      <input type="hidden" name="decision" value="REJECT" />
                      <input
                        name="note"
                        required
                        minLength={3}
                        maxLength={1000}
                        className={FIELD_INPUT}
                        placeholder={t('Why it is rejected', 'سبب الرفض')}
                      />
                      <button type="submit" className={BUTTON_SECONDARY} data-facility-reject>
                        {t('Reject', 'رفض')}
                      </button>
                    </form>
                  </div>
                </Gate>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-facility-propose>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Propose a facility', 'اقتراح تسهيل')}</h2>
        <Gate staff={staff} act="FACILITY_PROPOSE" arabic={arabic}>
          <form action={proposeFacilityAction} className="grid gap-3 sm:max-w-xl">
            <input type="hidden" name="locale" value={segment} />
            <label className="grid gap-1 text-[13px]">
              {t('Distributor', 'الموزع')}
              <select name="counterpartyId" className={FIELD_INPUT} required>
                {parties.value.distributors.map((d) => (
                  <option key={d.counterpartyId} value={d.counterpartyId}>
                    {t(d.nameEn, d.nameAr)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('Programme', 'البرنامج')}
              <select name="programmeId" className={FIELD_INPUT} required>
                {parties.value.programmes.map((p) => (
                  <option key={p.programmeId} value={p.programmeId}>
                    {t(p.nameEn, p.nameAr)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('Limit (riyals)', 'الحد (بالريال)')}
              <input name="limitRiyals" inputMode="numeric" required className={FIELD_INPUT} dir="ltr" />
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('What the limit rests on', 'ما يستند إليه الحد')}
              <textarea name="rationale" required minLength={3} maxLength={1000} rows={3} className={FIELD_TEXTAREA} />
            </label>
            <button type="submit" className={BUTTON_PRIMARY} data-facility-submit>
              {t('Propose', 'اقتراح')}
            </button>
          </form>
        </Gate>
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t(
            'A new approval replaces the facility in force. It is never above the programme’s limit, and never below what the distributor already holds.',
            'يحل الاعتماد الجديد محل التسهيل القائم، ولا يزيد على حد البرنامج ولا يقل عما يحتفظ به الموزع.',
          )}
        </p>
      </section>

      {decided.length === 0 ? null : (
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-facility-decided>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Recent decisions', 'آخر القرارات')}</h2>
          <ul className="divide-y divide-line text-[13px]">
            {decided.map((a) => (
              <li key={a.approvalId} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
                <span className="font-medium text-heading">{nameOf(a.counterpartyId)}</span>
                <span className="text-ink-quiet">{programmeName(a.programmeId)}</span>
                <span>{amount(a.limit.minorUnits)}</span>
                <span className={a.state === 'APPROVED' ? 'text-positive' : 'text-blocked'}>
                  {a.state === 'APPROVED' ? t('Approved', 'معتمد') : t('Rejected', 'مرفوض')}
                </span>
                <span className="text-ink-quiet">
                  {a.proposedBy} → {a.decidedBy}
                </span>
                {a.decisionNote === undefined ? null : <span className="text-ink-quiet">“{a.decisionNote}”</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
