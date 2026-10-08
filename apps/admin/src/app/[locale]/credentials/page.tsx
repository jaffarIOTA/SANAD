/**
 * Credentials: names, environments and dates, never values. Saving sends the
 * value once to the vault function and keeps a reference; the form field is
 * write-only and the list cannot show what it never receives.
 */

import { notFound, redirect } from 'next/navigation';

import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  PillLink,
  Status,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { revokeCredentialAction, saveCredentialAction } from '../../../server/actions.ts';
import {
  ENVIRONMENTS,
  KNOWN_KEY_NAMES,
  VAULT_PROVIDERS,
  listCredentials,
  listTenants,
  store,
} from '../../../server/credentials.ts';
import { currentAdmin } from '../../../server/session.ts';

const NOTICE: Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' | 'attention' }>> = {
  SAVED: {
    en: 'Saved to the vault. The value is not shown again.',
    ar: 'حُفظت في الخزنة. لا تُعرض القيمة مرة أخرى.',
    tone: 'settled',
  },
  REVOKED: {
    en: 'Revoked. A read now refuses instead of returning a stale value.',
    ar: 'أُلغيت. القراءة الآن تُرفض بدل إرجاع قيمة قديمة.',
    tone: 'settled',
  },
  NO_DATABASE: {
    en: 'No database is configured; the vault is unreachable.',
    ar: 'لا توجد قاعدة بيانات مهيأة؛ الخزنة غير متاحة.',
    tone: 'blocked',
  },
  SAVE_FAILED: { en: 'The vault refused the save.', ar: 'رفضت الخزنة الحفظ.', tone: 'blocked' },
  REVOKE_FAILED: { en: 'The vault refused the revocation.', ar: 'رفضت الخزنة الإلغاء.', tone: 'blocked' },
  SECRET_EMPTY: { en: 'The value was empty.', ar: 'القيمة فارغة.', tone: 'attention' },
  KEY_NAME_MALFORMED: {
    en: 'A key name is letters, digits and underscores, starting with a letter.',
    ar: 'اسم المفتاح حروف لاتينية وأرقام وشرطات سفلية، يبدأ بحرف.',
    tone: 'attention',
  },
  CONFIRMATION_REQUIRED: { en: 'Tick the confirmation to revoke.', ar: 'أكّد الإلغاء أولاً.', tone: 'attention' },
};

const fmt = (iso: string | null, locale: string): string =>
  iso === null
    ? '—'
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export default async function CredentialsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly tenant?: string; readonly notice?: string }>;
}) {
  const { locale: segment } = await params;
  const { tenant: tenantParam, notice } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  if ((await currentAdmin()) === undefined) redirect(`/${segment}`);
  const arabic = locale === 'ar-SA';
  const s = store();
  const tenants = s.kind === 'READY' ? await listTenants(s.pool) : [];
  const tenant = tenants.find((t) => t.code === tenantParam) ?? tenants[0];
  const rows = s.kind === 'READY' && tenant !== undefined ? await listCredentials(s.pool, tenant.code) : [];
  const n = notice === undefined ? undefined : NOTICE[notice];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-heading">{arabic ? 'بيانات الاعتماد' : 'Credentials'}</h2>
          <p className="mt-1 text-[15px] text-ink-quiet">
            {arabic
              ? 'الأسماء والبيئات والتواريخ فقط. القيمة تُكتب مرة واحدة إلى الخزنة ولا تُعرض أبداً.'
              : 'Names, environments and dates only. A value is written once to the vault and never shown.'}
          </p>
        </div>
        {tenants.length > 1 ? (
          <div className="flex items-center gap-2">
            {tenants.map((t) => (
              <PillLink
                key={t.code}
                href={`/${segment}/credentials?tenant=${encodeURIComponent(t.code)}`}
                variant={t.code === tenant?.code ? 'filled' : 'quiet'}
              >
                {t.code}
              </PillLink>
            ))}
          </div>
        ) : null}
      </div>

      {n !== undefined ? (
        n.tone === 'settled' ? (
          <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
            {arabic ? n.ar : n.en}
          </p>
        ) : (
          <ControlRejection
            control="OP-DETERMINACY"
            explanation={arabic ? n.ar : n.en}
            controlLabel={arabic ? 'الضابط' : 'Control'}
          />
        )
      ) : null}

      {s.kind !== 'READY' ? (
        <Card>
          <p className="text-[15px] text-ink">
            {arabic ? 'لا توجد قاعدة بيانات مهيأة.' : 'No database is configured.'}
          </p>
          <p className="mt-2 text-[14px] text-ink-quiet">
            {arabic
              ? 'ضع رابط PostgreSQL في SANAD_DATABASE_URL ثم أعد تشغيل التطبيق. الخزنة تعيش في قاعدة البيانات، لا في هذه الشاشة.'
              : 'Put the PostgreSQL connection string in SANAD_DATABASE_URL and restart the app. The vault lives in the database, not in this screen.'}
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <h3 className="text-[16px] font-semibold text-heading">
              {arabic ? `المحفوظ لـ ${tenant?.code ?? ''}` : `Saved for ${tenant?.code ?? ''}`}
            </h3>
            {rows.length === 0 ? (
              <p className="mt-3 text-[15px] text-ink-quiet">{arabic ? 'لا شيء بعد.' : 'Nothing yet.'}</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-[15px]">
                  <thead>
                    <tr className="border-b border-line text-start text-ink-quiet">
                      <th scope="col" className="py-3 pe-3 text-start font-normal">
                        {arabic ? 'المزوّد' : 'Provider'}
                      </th>
                      <th scope="col" className="py-3 pe-3 text-start font-normal">
                        {arabic ? 'البيئة' : 'Environment'}
                      </th>
                      <th scope="col" className="py-3 pe-3 text-start font-normal">
                        {arabic ? 'المفتاح' : 'Key'}
                      </th>
                      <th scope="col" className="hidden py-3 pe-3 text-start font-normal xl:table-cell">
                        {arabic ? 'الوصف' : 'Label'}
                      </th>
                      <th scope="col" className="py-3 pe-3 text-start font-normal">
                        {arabic ? 'الحالة' : 'Status'}
                      </th>
                      <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">
                        {arabic ? 'آخر تدوير' : 'Rotated'}
                      </th>
                      <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">
                        {arabic ? 'آخر قراءة' : 'Last read'}
                      </th>
                      <th scope="col" className="py-3 text-end font-normal">
                        {arabic ? 'إجراء' : 'Action'}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className="border-b border-line last:border-b-0">
                        <td className="whitespace-nowrap py-3 pe-3 font-medium text-heading">{c.provider}</td>
                        <td className="whitespace-nowrap py-3 pe-3 text-ink-quiet">{c.environment}</td>
                        <td className="py-3 pe-3">
                          <span className="identifier">{c.keyName}</span>
                        </td>
                        <td className="hidden py-3 pe-3 text-ink-quiet xl:table-cell">{c.label ?? '—'}</td>
                        <td className="py-3 pe-3">
                          <Status tone={c.status === 'ACTIVE' ? 'settled' : 'blocked'} label={c.status.toLowerCase()} />
                        </td>
                        <td className="hidden whitespace-nowrap py-3 pe-3 text-ink-quiet lg:table-cell">
                          {fmt(c.lastRotatedAt ?? c.createdAt, locale)}
                        </td>
                        <td className="hidden whitespace-nowrap py-3 pe-3 text-ink-quiet lg:table-cell">
                          {fmt(c.lastAccessedAt, locale)}
                        </td>
                        <td className="py-3 text-end">
                          {c.status === 'ACTIVE' ? (
                            <form action={revokeCredentialAction} className="inline-flex items-center gap-3">
                              <input type="hidden" name="locale" value={segment} />
                              <input type="hidden" name="tenant" value={tenant?.code ?? ''} />
                              <input type="hidden" name="credentialId" value={c.id} />
                              <label className="flex items-center gap-1.5 text-xs text-ink-quiet">
                                <input type="checkbox" name="confirm" value="yes" className="accent-blocked" />
                                {arabic ? 'تأكيد' : 'confirm'}
                              </label>
                              <button type="submit" className={`${BUTTON_DANGER} h-[38px] px-4 text-[14px]`}>
                                {arabic ? 'إلغاء' : 'Revoke'}
                              </button>
                            </form>
                          ) : (
                            <span className="text-xs text-ink-quiet">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'حفظ أو تدوير' : 'Save or rotate'}</h3>
            <p className="mt-1 text-[14px] text-ink-quiet">
              {arabic
                ? 'الحفظ باسم موجود يُدوّر القيمة ويحتفظ بالمرجع نفسه.'
                : 'Saving under an existing name rotates the value and keeps the same reference.'}
            </p>
            <form action={saveCredentialAction} className="mt-5 grid gap-5 md:grid-cols-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="tenant" value={tenant?.code ?? ''} />
              <label className={FIELD_LABEL}>
                {arabic ? 'المزوّد' : 'Provider'}
                <select name="provider" required defaultValue="NUTRIENT" className={FIELD_INPUT}>
                  {VAULT_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'البيئة' : 'Environment'}
                <select name="environment" required defaultValue="sandbox" className={FIELD_INPUT}>
                  {ENVIRONMENTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'اسم المفتاح' : 'Key name'}
                <input
                  name="keyName"
                  list="key-names"
                  required
                  pattern="[A-Za-z][A-Za-z0-9_]{1,63}"
                  placeholder="web_sdk_license_key"
                  className={`${FIELD_INPUT} identifier`}
                />
                <datalist id="key-names">
                  {Object.values(KNOWN_KEY_NAMES)
                    .flat()
                    .map((k) => (
                      <option key={k} value={k} />
                    ))}
                </datalist>
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'الوصف (اختياري)' : 'Label (optional)'}
                <input
                  name="label"
                  maxLength={120}
                  placeholder={arabic ? 'مثال: مفتاح تجريبي، أكتوبر ٢٠٢٦' : 'e.g. trial key, Oct 2026'}
                  className={FIELD_INPUT}
                />
              </label>
              <label className={`${FIELD_LABEL} md:col-span-2`}>
                {arabic ? 'القيمة — تُكتب مرة واحدة' : 'Value — written once'}
                <input
                  name="secret"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  className={`${FIELD_INPUT} identifier`}
                />
              </label>
              <div className="flex justify-end md:col-span-2">
                <button type="submit" className={BUTTON_PRIMARY}>
                  {arabic ? 'حفظ في الخزنة' : 'Save to the vault'}
                </button>
              </div>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
