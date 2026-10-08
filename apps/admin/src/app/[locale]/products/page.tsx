/**
 * Products & modules: the catalogue in force for the tenant, the revisions
 * proposed against it, a form to propose one change, and a live, read-only
 * view of the products the core banking platform itself offers, so a Sanad
 * product can be mapped to a core product code and the administrator can see
 * whether the core would price it by a rate. What one person proposes a
 * different person decides; until then nothing changes.
 */

import { notFound, redirect } from 'next/navigation';

import { type TenantCode, isTenantCode, loadProductCatalogue } from '@sanad/config/loader.ts';
import type { CoreBankingProductDetail, CoreBankingProductType } from '@sanad/core/ports/core-banking-catalogue.ts';
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, Card, ControlRejection, FIELD_INPUT, FIELD_LABEL, FIELD_TEXTAREA, PillLink, Status } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { decideRevisionAction, proposeProductAdditionAction, proposeProductChangeAction } from '../../../server/actions.ts';
import { coreProductsState, describeCoreProduct, listCoreProducts } from '../../../server/core-banking-products.ts';
import { listTenants, store } from '../../../server/credentials.ts';
import { REGISTRY, productsNotInCatalogue, resolveProductCatalogue } from '../../../server/products.ts';
import { listRevisions } from '../../../server/revisions.ts';
import { currentAdmin } from '../../../server/session.ts';

const NOTICE: Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' | 'attention' }>> = {
  PROPOSED: { en: 'Proposed. It takes effect only when a different administrator approves it.', ar: 'اقتُرح. لا يسري إلا بعد اعتماد مدير آخر.', tone: 'settled' },
  APPROVED: { en: 'Approved. It is in force from its effective moment.', ar: 'اعتُمد. يسري من لحظة نفاذه.', tone: 'settled' },
  REJECTED: { en: 'Rejected, with the reason recorded.', ar: 'رُفض وسُجّل السبب.', tone: 'settled' },
  NO_DATABASE: { en: 'No database is configured; revisions live in the database.', ar: 'لا توجد قاعدة بيانات مهيأة؛ المراجعات تعيش في قاعدة البيانات.', tone: 'blocked' },
  PROPOSE_FAILED: { en: 'The database refused the proposal.', ar: 'رفضت قاعدة البيانات الاقتراح.', tone: 'blocked' },
  DECIDE_FAILED: { en: 'The database refused the decision.', ar: 'رفضت قاعدة البيانات القرار.', tone: 'blocked' },
  REJECTION_REASON_REQUIRED: { en: 'A rejection says why.', ar: 'الرفض يحتاج سبباً.', tone: 'attention' },
  EFFECTIVE_FROM_MALFORMED: { en: 'The effective date could not be read.', ar: 'تعذّر قراءة تاريخ النفاذ.', tone: 'attention' },
  CATALOGUE_UNREADABLE: { en: 'The current catalogue does not load; fix it before proposing against it.', ar: 'الكتالوج الحالي لا يُحمَّل؛ أصلحه قبل الاقتراح عليه.', tone: 'blocked' },
  'REFUSED:FOUR_EYES_SELF_DECISION': { en: 'Four eyes: you proposed this revision, so you may not decide it. Sign in as the other administrator.', ar: 'أربع أعين: أنت من اقترح هذه المراجعة فلا يجوز أن تقرر فيها. سجّل الدخول بالمدير الآخر.', tone: 'blocked' },
};

const fmt = (iso: string, locale: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

/** A product booked as account postings carries no core product code; the parser refuses one (SH-01). */
function accountPosted(productCode: string): boolean {
  const m = REGISTRY.find(productCode);
  return m.ok && m.value.descriptor.bookingShape === 'ACCOUNT_POSTINGS';
}

/** The currency the tenant's products are denominated in; the core's list is filtered to it unless the operator asks for all. */
const TENANT_CURRENCY = 'SAR';

export default async function ProductsAdminPage({ params, searchParams }: { readonly params: Promise<{ readonly locale: string }>; readonly searchParams: Promise<{ readonly tenant?: string; readonly notice?: string; readonly edit?: string; readonly core?: string; readonly coreProduct?: string }> }) {
  const { locale: segment } = await params;
  const { tenant: tenantParam, notice, edit, core, coreProduct } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${segment}`);
  const arabic = locale === 'ar-SA';
  const s = store();
  const tenants = s.kind === 'READY' ? await listTenants(s.pool) : [];
  const tenantCode: TenantCode = tenantParam !== undefined && isTenantCode(tenantParam) ? tenantParam : 'bank-a';
  const now = BigInt(Math.floor(Date.now() / 1000));
  const resolved = await resolveProductCatalogue(tenantCode, now);
  const entries = resolved.catalogue.ok ? resolved.catalogue.value.entries : [];
  const revisions = s.kind === 'READY' ? await listRevisions(s.pool, tenantCode, 'PRODUCTS') : [];
  const editing = entries.find((e) => e.productCode === edit) ?? entries[0];
  // Shipped modules that are not in the catalogue in force, offered from the tenant's checked-in term sheet.
  const template = loadProductCatalogue(tenantCode);
  const addable = resolved.catalogue.ok && template.ok ? productsNotInCatalogue(resolved.catalogue.value, template.value) : [];
  const pendingAdditions = new Set(revisions.filter((r) => r.status === 'PROPOSED').map((r) => /^Add (\S+) to the catalogue/.exec(r.summary)?.[1]).filter((c): c is string => c !== undefined));
  const n = notice === undefined ? undefined : (NOTICE[notice] ?? (notice.startsWith('REFUSED:') ? { en: `Refused before proposal: ${notice.slice(8)}`, ar: `رُفض قبل الاقتراح: ${notice.slice(8)}`, tone: 'blocked' as const } : undefined));

  // The core banking platform's own products, read live. Unavailability is shown, never hidden behind an empty table.
  const coreState = await coreProductsState(tenantCode, now);
  const coreList = await listCoreProducts(coreState);
  const coreProducts: readonly CoreBankingProductType[] = coreList?.kind === 'ANSWERED' ? coreList.value : [];
  const showAll = core === 'all';
  const visibleCore = showAll ? coreProducts : coreProducts.filter((p) => p.currency === TENANT_CURRENCY);
  const detail = coreProduct === undefined ? undefined : await describeCoreProduct(coreState, coreProduct);
  const coreCodes = new Set(coreProducts.map((p) => p.code));
  const base = `/${segment}/products?tenant=${encodeURIComponent(tenantCode)}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-heading">{arabic ? 'المنتجات والوحدات' : 'Products & modules'}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-[15px] text-ink-quiet">
            <span>{arabic ? 'الكتالوج الساري الآن لـ' : 'Catalogue in force now for'} <span className="identifier">{tenantCode}</span></span>
            <Status tone={resolved.source === 'REVISION' ? 'settled' : 'progress'} label={resolved.source === 'REVISION' ? (arabic ? `مراجعة معتمدة: ${resolved.revisionSummary ?? ''}` : `approved revision: ${resolved.revisionSummary ?? ''}`) : (arabic ? 'من الملف المضمّن — لا مراجعة معتمدة بعد' : 'from the checked-in file — no approved revision yet')} />
          </p>
        </div>
        {tenants.length > 1 ? <div className="flex items-center gap-2">{tenants.map((t) => <PillLink key={t.code} href={`/${segment}/products?tenant=${encodeURIComponent(t.code)}`} variant={t.code === tenantCode ? 'filled' : 'quiet'}>{t.code}</PillLink>)}</div> : null}
      </div>

      {n !== undefined ? (n.tone === 'settled' ? <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">{arabic ? n.ar : n.en}</p> : <ControlRejection control="OP-DETERMINACY" explanation={arabic ? n.ar : n.en} controlLabel={arabic ? 'الضابط' : 'Control'} />) : null}

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'المنتجات' : 'Products'}</h3>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-[15px]">
            <thead><tr className="border-b border-line text-ink-quiet">
              <th scope="col" className="py-3 pe-3 text-start font-normal">{arabic ? 'المنتج' : 'Product'}</th>
              <th scope="col" className="py-3 pe-3 text-start font-normal">{arabic ? 'الوحدة' : 'Module'}</th>
              <th scope="col" className="py-3 pe-3 text-start font-normal">{arabic ? 'الحالة' : 'State'}</th>
              <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">{arabic ? 'قرار الهيئة' : 'Board ruling'}</th>
              <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">{arabic ? 'منتج النظام المصرفي' : 'Core product'}</th>
              <th scope="col" className="hidden py-3 pe-3 text-start font-normal xl:table-cell">{arabic ? 'قاعدة التسعير' : 'Pricing rule'}</th>
              <th scope="col" className="py-3 text-end font-normal">{arabic ? 'إجراء' : 'Action'}</th>
            </tr></thead>
            <tbody>
              {entries.map((e) => {
                const m = REGISTRY.find(e.productCode);
                const mapped = e.coreBankingProductCode;
                const known = mapped !== undefined && coreCodes.has(mapped);
                return (
                  <tr key={e.productCode} className="border-b border-line last:border-b-0">
                    <td className="py-3 pe-3"><span className="font-medium text-heading">{arabic ? e.nameAr : e.nameEn}</span><br /><span className="identifier text-xs text-ink-quiet">{e.productCode}</span></td>
                    <td className="py-3 pe-3 text-ink-quiet">{m.ok ? (arabic ? m.value.descriptor.nameAr : m.value.descriptor.nameEn) : '—'}</td>
                    <td className="py-3 pe-3"><Status tone={e.enabled ? 'settled' : 'blocked'} label={e.enabled ? (arabic ? 'مفعّل' : 'enabled') : (arabic ? 'معطّل' : 'disabled')} /></td>
                    <td className="hidden py-3 pe-3 lg:table-cell"><span className="identifier text-ink-quiet">{e.boardRulingRef ?? '—'}</span></td>
                    <td className="hidden py-3 pe-3 lg:table-cell">
                      {m.ok && m.value.descriptor.bookingShape === 'ACCOUNT_POSTINGS' ? <span className="text-ink-quiet">{arabic ? 'قيود حسابات' : 'account postings'}</span> : mapped === undefined ? <span className="text-ink-quiet">{arabic ? 'غير مرتبط' : 'not mapped'}</span> : (
                        <span className="flex flex-wrap items-center gap-2">
                          <a href={`${base}&coreProduct=${encodeURIComponent(mapped)}#core`} className="identifier text-brand underline-offset-2 hover:underline">{mapped}</a>
                          {coreProducts.length > 0 ? <Status tone={known ? 'settled' : 'blocked'} label={known ? (arabic ? 'موجود في النظام' : 'in the core') : (arabic ? 'غير موجود في النظام' : 'not in the core')} /> : null}
                        </span>
                      )}
                    </td>
                    <td className="hidden py-3 pe-3 text-ink-quiet xl:table-cell">{e.pricingRule.kind}</td>
                    <td className="py-3 text-end"><PillLink href={`${base}&edit=${encodeURIComponent(e.productCode)}#propose`}>{arabic ? 'اقتراح تغيير' : 'Propose a change'}</PillLink></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {addable.length > 0 ? (
        <Card>
          <h3 id="add" className="text-[16px] font-semibold text-heading">{arabic ? 'إضافة منتج إلى الكتالوج' : 'Add a product to the catalogue'}</h3>
          <p className="mt-1 text-[14px] text-ink-quiet">{arabic ? 'وحدات تقدّمها المنصة وليست في الكتالوج الساري. تُقترح الإضافة بورقة الشروط المضمّنة لهذه المؤسسة، ويعتمدها مدير آخر؛ المنتج الإسلامي يُضاف معطّلاً حتى يُسجَّل قرار الهيئة.' : 'Modules the platform ships that are not in the catalogue in force. Adding one is proposed with this tenant’s checked-in term sheet and approved by another administrator; an Islamic product is added disabled until its board ruling is recorded.'}</p>
          <ul className="mt-4 flex list-none flex-col divide-y divide-line p-0">
            {addable.map((e) => {
              const m = REGISTRY.find(e.productCode);
              const pending = pendingAdditions.has(e.productCode);
              return (
                <li key={e.productCode} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-heading">{arabic ? e.nameAr : e.nameEn}</span>
                    <span className="text-[13px] text-ink-quiet"><span className="identifier">{e.productCode}</span> · {m.ok ? (m.value.descriptor.family === 'ISLAMIC' ? (arabic ? 'إسلامي' : 'Islamic') : (arabic ? 'تقليدي' : 'conventional')) : ''} · {e.enabled ? (arabic ? 'يُضاف مفعّلاً' : 'added enabled') : (arabic ? 'يُضاف معطّلاً' : 'added disabled')}</span>
                  </span>
                  {pending ? <Status tone="progress" label={arabic ? 'إضافة مقترحة بانتظار الاعتماد' : 'addition proposed, awaiting approval'} /> : (
                    <form action={proposeProductAdditionAction}>
                      <input type="hidden" name="locale" value={segment} /><input type="hidden" name="tenant" value={tenantCode} /><input type="hidden" name="productCode" value={e.productCode} />
                      <button type="submit" className={`${BUTTON_PRIMARY} h-[38px] min-w-0 px-4 text-[14px]`}>{arabic ? 'اقتراح الإضافة' : 'Propose adding'}</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="core" className="text-[16px] font-semibold text-heading">{arabic ? 'في النظام المصرفي الأساسي' : 'In the core banking platform'}</h3>
            <p className="mt-1 text-[14px] text-ink-quiet">{arabic ? 'قراءة حية فقط: أنواع المنتجات التي يعرّفها النظام المصرفي، وهل يسعّرها بمعدّل. لا شيء هنا يُحجز أو يُسعَّر.' : 'A live read only: the product types the core defines, and whether it prices them by a rate. Nothing here books or prices.'}</p>
          </div>
          {coreState.kind === 'READY' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Status tone={coreState.enabled ? 'settled' : 'progress'} label={`${coreState.adapter} · ${coreState.environment} · ${coreState.enabled ? (arabic ? 'القناة مفعّلة' : 'rail enabled') : (arabic ? 'القناة معطّلة للحجز' : 'rail disabled for booking')}`} />
              <PillLink href={`${base}#core`} variant={showAll ? 'quiet' : 'filled'}>{TENANT_CURRENCY}</PillLink>
              <PillLink href={`${base}&core=all#core`} variant={showAll ? 'filled' : 'quiet'}>{arabic ? 'كل العملات' : 'all currencies'}</PillLink>
            </div>
          ) : null}
        </div>

        {coreState.kind === 'NO_DATABASE' ? <p className="mt-4 text-[15px] text-ink-quiet">{arabic ? 'لا توجد قاعدة بيانات؛ بيانات اعتماد النظام المصرفي تعيش في الخزنة.' : 'No database; the core’s credentials live in the vault.'}</p> : null}
        {coreState.kind === 'NO_RAIL' ? <p className="mt-4 text-[15px] text-ink-quiet">{arabic ? 'لا قناة نظام مصرفي في إعدادات هذه المؤسسة. أضفها في «قنوات التكامل».' : 'No core banking rail is configured for this tenant. Add one under Rails & adapters.'}</p> : null}
        {coreState.kind === 'UNSUPPORTED_ADAPTER' ? <p className="mt-4 text-[15px] text-ink-quiet">{arabic ? `لا يوجد قارئ كتالوج للمحوّل ${coreState.adapter}.` : `No catalogue reader exists for the ${coreState.adapter} adapter.`}</p> : null}
        {coreState.kind === 'NOT_CONFIGURED' ? (
          <ControlRejection control="OP-DETERMINACY" controlLabel={arabic ? 'الضابط' : 'Control'} explanation={arabic ? `بيانات اعتماد ${coreState.adapter} (${coreState.environment}) ناقصة في الخزنة: ${coreState.missing.join('، ')}. احفظها في «بيانات الاعتماد».` : `The ${coreState.adapter} (${coreState.environment}) credentials are incomplete in the vault: ${coreState.missing.join(', ')}. Save them under Credentials.`} />
        ) : null}
        {coreList !== undefined && coreList.kind === 'UNAVAILABLE' ? (
          <ControlRejection control="OP-DETERMINACY" controlLabel={arabic ? 'الضابط' : 'Control'} explanation={arabic ? `النظام المصرفي غير متاح الآن (${coreList.reason}). لا تُعرض قائمة قديمة بدلاً منه.` : `The core banking platform is unavailable (${coreList.reason}). No stale list is shown in its place.`} />
        ) : null}
        {coreList !== undefined && coreList.kind === 'REFUSED' ? (
          <ControlRejection control="OP-DETERMINACY" controlLabel={arabic ? 'الضابط' : 'Control'} explanation={arabic ? `رفض النظام المصرفي الطلب: ${coreList.code}` : `The core banking platform refused the request: ${coreList.code}`} />
        ) : null}

        {coreList?.kind === 'ANSWERED' ? (
          <>
            <p className="mt-4 text-[13px] text-ink-quiet">{arabic ? `${visibleCore.length} من ${coreProducts.length} نوع منتج${showAll ? '' : ` بعملة ${TENANT_CURRENCY}`}. ما ليس تحت وحدة هذه المؤسسة هو منتجات اختبار لشركاء آخرين في بيئة مشتركة.` : `${visibleCore.length} of ${coreProducts.length} product types${showAll ? '' : ` in ${TENANT_CURRENCY}`}. Products not under this institution’s unit are other partners’ test products in a shared sandbox.`}</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-[15px]">
                <thead><tr className="border-b border-line text-ink-quiet">
                  <th scope="col" className="py-3 pe-3 text-start font-normal">{arabic ? 'الرمز' : 'Code'}</th>
                  <th scope="col" className="py-3 pe-3 text-start font-normal">{arabic ? 'الوصف' : 'Description'}</th>
                  <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">{arabic ? 'المجموعة' : 'Group'}</th>
                  <th scope="col" className="py-3 pe-3 text-start font-normal">{arabic ? 'العملة' : 'Currency'}</th>
                  <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">{arabic ? 'الدولة' : 'Country'}</th>
                  <th scope="col" className="hidden py-3 pe-3 text-start font-normal xl:table-cell">{arabic ? 'الوحدة' : 'Unit'}</th>
                  <th scope="col" className="py-3 pe-3 text-start font-normal">{arabic ? 'الحالة' : 'Status'}</th>
                  <th scope="col" className="py-3 text-end font-normal">{arabic ? 'تفاصيل' : 'Detail'}</th>
                </tr></thead>
                <tbody>
                  {visibleCore.map((p) => (
                    <tr key={`${p.unit}/${p.code}`} className={`border-b border-line last:border-b-0 ${p.code === coreProduct ? 'bg-surface-raised' : ''}`}>
                      <td className="py-3 pe-3"><span className="identifier text-heading">{p.code}</span></td>
                      <td className="py-3 pe-3 text-ink">{p.description}</td>
                      <td className="hidden py-3 pe-3 text-ink-quiet lg:table-cell">{p.groupDescription || p.group}</td>
                      <td className="py-3 pe-3 text-ink-quiet">{p.currency}</td>
                      <td className="hidden py-3 pe-3 text-ink-quiet lg:table-cell">{p.country}</td>
                      <td className="hidden py-3 pe-3 xl:table-cell"><span className="identifier text-ink-quiet">{p.unit}</span></td>
                      <td className="py-3 pe-3"><Status tone={p.status === 'ACTIVE' ? 'settled' : 'blocked'} label={p.status.toLowerCase()} /></td>
                      <td className="py-3 text-end"><PillLink href={`${base}${showAll ? '&core=all' : ''}&coreProduct=${encodeURIComponent(p.code)}#core`} variant={p.code === coreProduct ? 'filled' : 'quiet'}>{arabic ? 'عرض' : 'View'}</PillLink></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {detail !== undefined ? <CoreProductDetail detail={detail} arabic={arabic} code={coreProduct ?? ''} /> : null}
      </Card>

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'المراجعات' : 'Revisions'}</h3>
        <p className="mt-1 text-[14px] text-ink-quiet">{arabic ? `أنت ${admin.principalId}. ما اقترحته لا تقرره؛ يقرره مدير آخر.` : `You are ${admin.principalId}. What you proposed, another administrator decides.`}</p>
        {revisions.length === 0 ? <p className="mt-3 text-[15px] text-ink-quiet">{arabic ? 'لا مراجعات بعد.' : 'No revisions yet.'}</p> : (
          <ul className="mt-4 flex list-none flex-col divide-y divide-line p-0">
            {revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2"><span className="text-[15px] font-medium text-heading">{r.summary}</span><Status tone={r.status === 'APPROVED' ? 'settled' : r.status === 'REJECTED' ? 'blocked' : 'progress'} label={r.status.toLowerCase()} /></span>
                  <span className="text-[13px] text-ink-quiet">
                    {arabic ? 'نافذة من' : 'effective'} {fmt(r.effectiveFrom, locale)} · {arabic ? 'اقترحها' : 'proposed by'} <span className="identifier">{r.proposedBy}</span> {fmt(r.proposedAt, locale)}
                    {r.decidedBy !== null && r.decidedAt !== null ? <> · {r.status === 'APPROVED' ? (arabic ? 'اعتمدها' : 'approved by') : (arabic ? 'رفضها' : 'rejected by')} <span className="identifier">{r.decidedBy}</span> {fmt(r.decidedAt, locale)}{r.rejectionReason !== null ? ` — ${r.rejectionReason}` : ''}</> : null}
                  </span>
                </span>
                {r.status === 'PROPOSED' ? (
                  <form action={decideRevisionAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="locale" value={segment} /><input type="hidden" name="tenant" value={tenantCode} /><input type="hidden" name="area" value="products" /><input type="hidden" name="revisionId" value={r.id} />
                    <input name="reason" placeholder={arabic ? 'سبب الرفض' : 'reason, if rejecting'} className={`${FIELD_INPUT} mt-0 h-[38px] w-[220px] text-[14px]`} />
                    <button type="submit" name="decision" value="reject" disabled={r.proposedBy === admin.principalId} className={`${BUTTON_DANGER} h-[38px] px-4 text-[14px] disabled:opacity-40`}>{arabic ? 'رفض' : 'Reject'}</button>
                    <button type="submit" name="decision" value="approve" disabled={r.proposedBy === admin.principalId} className={`${BUTTON_PRIMARY} h-[38px] min-w-0 px-4 text-[14px] disabled:opacity-40`}>{arabic ? 'اعتماد' : 'Approve'}</button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing !== undefined ? (
        <Card>
          <h3 id="propose" className="text-[16px] font-semibold text-heading">{arabic ? 'اقتراح تغيير' : 'Propose a change'}</h3>
          <p className="mt-1 text-[14px] text-ink-quiet">{arabic ? 'يُتحقق من ورقة الشروط بمحلّل الوحدة نفسه الذي يستخدمه الإنتاج قبل أن يُقترح أي شيء؛ ما لا يُحمَّل لا يُقترح.' : 'The term sheet is checked by the module’s own parser, the one production uses, before anything is proposed; what would not load cannot be proposed.'}</p>
          <form action={proposeProductChangeAction} className="mt-5 grid gap-5 md:grid-cols-2">
            <input type="hidden" name="locale" value={segment} /><input type="hidden" name="tenant" value={tenantCode} />
            <label className={FIELD_LABEL}>{arabic ? 'المنتج' : 'Product'}
              <select name="productCode" defaultValue={editing.productCode} className={FIELD_INPUT}>{entries.map((e) => <option key={e.productCode} value={e.productCode}>{e.productCode}</option>)}</select>
              <span className="mt-2 block text-[13px] text-ink-quiet">{arabic ? 'لتعديل منتج آخر اختره من الجدول أعلاه، فتُحمَّل شروطه الحالية هنا.' : 'To edit another product choose it in the table above; its current terms load here.'}</span>
            </label>
            <label className={FIELD_LABEL}>{arabic ? 'نافذ من' : 'Effective from'}
              <input name="effectiveFrom" type="datetime-local" className={FIELD_INPUT} />
              <span className="mt-2 block text-[13px] text-ink-quiet">{arabic ? 'فارغ = من لحظة الاعتماد.' : 'Empty = from the moment of approval.'}</span>
            </label>
            <label className="flex items-center gap-3 text-[16px] text-ink md:col-span-2"><input type="checkbox" name="enabled" defaultChecked={editing.enabled} className="size-4 accent-brand-deep" />{arabic ? 'مفعّل لهذه المؤسسة' : 'Enabled for this tenant'}</label>
            <label className={FIELD_LABEL}>{arabic ? 'قرار الهيئة الشرعية (للمنتجات الإسلامية)' : 'Board ruling reference (Islamic products)'}
              <input name="boardRulingRef" defaultValue={editing.boardRulingRef ?? ''} className={`${FIELD_INPUT} identifier`} />
            </label>
            {accountPosted(editing.productCode) ? (
              <div className={FIELD_LABEL}>{arabic ? 'منتج النظام المصرفي' : 'Core banking product code'}
                <p className="mt-2 text-[14px] text-ink-quiet">{arabic ? 'لا يُربط هذا المنتج بمنتج في النظام المصرفي: سعره المؤجل ثابت، فيُحجز كقيود حسابات ويبقى الجدول والربح في سند. منتجات التمويل في النظام المصرفي تُسعَّر بمعدّل (SH-01).' : 'This product is not mapped to a core product: its deferred price is fixed, so it books as account postings with the schedule and profit held in Sanad. The core’s lending products price by a rate (SH-01).'}</p>
              </div>
            ) : (
              <label className={FIELD_LABEL}>{arabic ? 'منتج النظام المصرفي (اختياري)' : 'Core banking product code (optional)'}
                <input name="coreBankingProductCode" list="core-product-codes" defaultValue={editing.coreBankingProductCode ?? ''} maxLength={64} placeholder={arabic ? 'رمز نوع المنتج في النظام المصرفي' : 'the core’s product type code'} className={`${FIELD_INPUT} identifier`} />
                <datalist id="core-product-codes">{coreProducts.map((p) => <option key={`${p.unit}/${p.code}`} value={p.code}>{p.description}</option>)}</datalist>
                <span className="mt-2 block text-[13px] text-ink-quiet">{arabic ? 'اختر من القائمة أدناه «في النظام المصرفي الأساسي». فارغ = غير مرتبط.' : 'Pick from the list under “In the core banking platform” below. Empty = not mapped.'}</span>
              </label>
            )}
            <label className={FIELD_LABEL}>{arabic ? 'ملخص التغيير' : 'Summary of the change'}
              <input name="summary" required minLength={3} maxLength={400} placeholder={arabic ? 'مثال: رفع حد BNPL إلى ٧٬٠٠٠ ريال' : 'e.g. raise the BNPL limit to SAR 7,000'} className={FIELD_INPUT} />
            </label>
            <label className={`${FIELD_LABEL} md:col-span-2`}>{arabic ? 'ورقة الشروط (JSON)' : 'Term sheet (JSON)'}
              <textarea name="terms" rows={10} required spellCheck={false} defaultValue={JSON.stringify(editing.terms, null, 2)} className={`${FIELD_TEXTAREA} identifier text-[13px]`} />
            </label>
            <div className="flex flex-wrap justify-end gap-3 md:col-span-2">
              <a href={base} className={BUTTON_SECONDARY}>{arabic ? 'إلغاء' : 'Cancel'}</a>
              <button type="submit" className={BUTTON_PRIMARY}>{arabic ? 'اقتراح' : 'Propose'}</button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function CoreProductDetail({ detail, arabic, code }: { readonly detail: Awaited<ReturnType<typeof describeCoreProduct>>; readonly arabic: boolean; readonly code: string }) {
  if (detail === undefined) return null;
  if (detail.kind === 'UNAVAILABLE') return <p className="mt-5 text-[15px] text-blocked">{arabic ? `تعذّر قراءة ${code}: النظام غير متاح (${detail.reason}).` : `${code} could not be read: the core is unavailable (${detail.reason}).`}</p>;
  if (detail.kind === 'REFUSED') return <p className="mt-5 text-[15px] text-blocked">{arabic ? `رفض النظام قراءة ${code}: ${detail.code}` : `The core refused to describe ${code}: ${detail.code}`}</p>;
  const d: CoreBankingProductDetail = detail.value;
  const rows: readonly (readonly [string, string])[] = [
    [arabic ? 'شكل الجدول' : 'Schedule shape', d.scheduleShape || '—'],
    [arabic ? 'حدود المبلغ (كما ينشرها النظام)' : 'Amount limits (as the core publishes them)', d.amountLimits === undefined ? '—' : `${d.amountLimits.lowText} – ${d.amountLimits.highText} ${d.summary.currency}`],
    [arabic ? 'حدود المدة' : 'Period limits', d.periodLimits === undefined ? '—' : `${String(d.periodLimits.low)} – ${String(d.periodLimits.high)}`],
    [arabic ? 'دورة السداد' : 'Repayment cycle', d.repaymentCycle === undefined ? '—' : [d.repaymentCycle.frequency === undefined ? '' : `${String(d.repaymentCycle.frequency)} × ${d.repaymentCycle.unit ?? ''}`, d.repaymentCycle.invoiceTermDays === undefined ? '' : (arabic ? `أجل الفاتورة ${String(d.repaymentCycle.invoiceTermDays)} يوماً` : `invoice term ${String(d.repaymentCycle.invoiceTermDays)} days`), d.repaymentCycle.minBillingPeriodDays === undefined ? '' : (arabic ? `أدنى فترة فوترة ${String(d.repaymentCycle.minBillingPeriodDays)} يوماً` : `min billing period ${String(d.repaymentCycle.minBillingPeriodDays)} days`)].filter((x) => x.length > 0).join(' · ')],
    [arabic ? 'مراجعة قبل العرض' : 'Review before offer', d.reviewRequiredBeforeOffer ? (arabic ? 'مطلوبة' : 'required') : (arabic ? 'غير مطلوبة' : 'not required')],
  ];
  return (
    <div className="mt-6 border-t border-line pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-[15px] font-semibold text-heading"><span className="identifier">{d.summary.code}</span> · {d.summary.description}</h4>
        <Status tone={d.pricingMethod === 'RATE_DRIVEN' ? 'blocked' : d.pricingMethod === 'NOT_RATE_DRIVEN' ? 'settled' : 'progress'} label={d.pricingMethod === 'RATE_DRIVEN' ? (arabic ? `يُسعَّر بمعدّل${d.rateBasis === undefined ? '' : ` (${d.rateBasis})`}` : `rate driven${d.rateBasis === undefined ? '' : ` (${d.rateBasis})`}`) : d.pricingMethod === 'NOT_RATE_DRIVEN' ? (arabic ? 'لا يُسعَّر بمعدّل' : 'not rate driven') : (arabic ? 'طريقة التسعير غير معروفة' : 'pricing method unknown')} />
      </div>
      <dl className="mt-4 grid gap-x-8 gap-y-3 text-[14px] md:grid-cols-2">
        {rows.map(([k, v]) => <div key={k} className="flex flex-col gap-0.5"><dt className="text-ink-quiet">{k}</dt><dd className="text-ink">{v}</dd></div>)}
        <div className="flex flex-col gap-0.5 md:col-span-2">
          <dt className="text-ink-quiet">{arabic ? 'مكوّنات التسعير في النظام (قيم النظام كما هي، للعرض فقط)' : 'Pricing components in the core (the core’s values verbatim, display only)'}</dt>
          <dd className="text-ink">{d.components.length === 0 ? '—' : d.components.map((c) => `${c.component} = ${c.valueText}${c.kind === 'RATE' ? (arabic ? ' (معدّل)' : ' (rate)') : c.kind === 'FEE' ? (arabic ? ' (رسم)' : ' (fee)') : ''}`).join(' · ')}</dd>
        </div>
      </dl>
      {d.pricingMethod === 'RATE_DRIVEN' ? (
        <p className="mt-4 text-[13px] text-ink-quiet">{arabic ? 'النظام المصرفي يشتق تكلفة التمويل من المعدّل والأيام تحت هذا المنتج. منتج مرابحة بسعر مؤجل ثابت لا يُحجز تحته؛ أما المنتجات المسعّرة بمعدّل فتمرّر سند معدّلها صراحةً وتُطابق ما يعيده النظام، ويبقى معدّل النسبة السنوي المُفصح عنه هو ما يحسبه سند.' : 'Under this product the core derives the cost of credit from the rate and the days. A Murabaha with a fixed deferred price is not booked under it; for rate-priced products Sanad passes its own rate explicitly and reconciles the echo, and the disclosed APR stays the one Sanad computes.'}</p>
      ) : null}
    </div>
  );
}
