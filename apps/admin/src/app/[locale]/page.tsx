/**
 * Sign in. Development: the platform operations token, compared by digest on
 * the server. Production: the institution's identity provider.
 */

import { notFound, redirect } from 'next/navigation';

import { BUTTON_PRIMARY, Card, ControlRejection, FIELD_INPUT, FIELD_LABEL } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { signInAction } from '../../server/actions.ts';
import { currentAdmin } from '../../server/session.ts';

export default async function SignInPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly notice?: string }>;
}) {
  const { locale: segment } = await params;
  const { notice } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  if ((await currentAdmin()) !== undefined) redirect(`/${segment}/credentials`);
  const arabic = locale === 'ar-SA';

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{arabic ? 'تسجيل الدخول' : 'Sign in'}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {arabic
            ? 'في بيئة التطوير: رمز عمليات المنصة من ملف البيئة المحلي. في الإنتاج: موفّر هوية المؤسسة.'
            : 'Development: the platform operations token from your local environment file. Production: the institution’s identity provider.'}
        </p>
      </div>
      {notice === 'SIGN_IN_REFUSED' ? (
        <ControlRejection
          control="OP-DETERMINACY"
          explanation={arabic ? 'الرمز غير مطابق.' : 'The token did not match.'}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}
      <Card>
        <form action={signInAction} className="flex flex-col gap-6">
          <input type="hidden" name="locale" value={segment} />
          <label className={FIELD_LABEL}>
            {arabic ? 'رمز عمليات المنصة' : 'Platform operations token'}
            <input name="token" type="password" autoComplete="off" required className={`${FIELD_INPUT} identifier`} />
          </label>
          <div className="flex justify-end">
            <button type="submit" className={BUTTON_PRIMARY}>
              {arabic ? 'دخول' : 'Sign in'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
