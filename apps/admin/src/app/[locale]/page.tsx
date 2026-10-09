/**
 * Sign in.
 *
 * Production: the institution's single sign-on by OpenID Connect. The page
 * lists the institutions active in this deployment's jurisdiction whose staff
 * identity configuration uses OIDC; the person is an administrator only if
 * that institution maps one of their groups to PLATFORM_ADMIN. No development
 * path is offered (the action refuses it too).
 *
 * Development: the platform operations token, compared by digest on the
 * server; single sign-on is offered as well wherever an institution's
 * configuration in force uses OIDC.
 *
 * Arabic first; every word on the page in both languages.
 */

import { notFound, redirect } from 'next/navigation';

import { BUTTON_PRIMARY, Card, ControlRejection, FIELD_INPUT, FIELD_LABEL } from '@sanad/design/primitives.tsx';
import { SingleSignOnCard } from '@sanad/design/SingleSignOn.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { singleSignOnInstitutions } from '@sanad/origination/staff-identity.ts';

import { signInAction, singleSignOnAction } from '../../server/actions.ts';
import { currentAdmin, developmentSignInPermitted, now } from '../../server/session.ts';

type Words = { readonly en: string; readonly ar: string; readonly refusal: boolean };

const NOTICES: Readonly<Record<string, Words>> = {
  SIGN_IN_REFUSED: {
    en: 'Your sign-in was not recognised, or it does not carry the platform administrator authority under your institution’s staff identity configuration.',
    ar: 'لم يُتعرَّف على تسجيل دخولك، أو أنه لا يمنح صلاحية مسؤول المنصة وفق إعدادات هوية الموظفين لدى مؤسستك.',
    refusal: true,
  },
  SSO_FAILED: {
    en: 'Sign-in through your institution could not be completed. Nothing was signed in. Start again from this page.',
    ar: 'تعذّر إكمال تسجيل الدخول عبر مؤسستك، ولم يُسجَّل دخول أحد. ابدأ من جديد من هذه الصفحة.',
    refusal: true,
  },
  SSO_UNAVAILABLE: {
    en: 'Single sign-on is not set up for that institution in this deployment.',
    ar: 'الدخول الموحد غير مهيأ لتلك المؤسسة في هذه البيئة.',
    refusal: true,
  },
  TENANT_NOT_ACTIVE: {
    en: 'Your institution is not active in the jurisdiction this deployment runs as.',
    ar: 'مؤسستك غير مفعّلة في الولاية التي يعمل بها هذا التطبيق.',
    refusal: true,
  },
  DEVELOPMENT_SIGN_IN_REFUSED: {
    en: 'Development tokens are refused in production. Sign in through your institution’s single sign-on.',
    ar: 'رموز التطوير مرفوضة في بيئة الإنتاج. سجّل الدخول عبر نظام الدخول الموحد لمؤسستك.',
    refusal: true,
  },
  SIGNED_OUT: { en: 'You are signed out.', ar: 'تم تسجيل خروجك.', refusal: false },
};

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
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const words = notice === undefined ? undefined : NOTICES[notice];
  const development = developmentSignInPermitted();
  const institutions = await singleSignOnInstitutions(now());

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{t('Sign in', 'تسجيل الدخول')}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {t(
            'Administrators sign in through their institution’s identity provider. In development, the platform operations token from your local environment file also works.',
            'يسجّل المسؤولون الدخول عبر مزوّد الهوية في مؤسستهم. وفي بيئة التطوير يعمل أيضاً رمز عمليات المنصة من ملف البيئة المحلي.',
          )}
        </p>
      </div>
      {words === undefined ? null : words.refusal ? (
        <ControlRejection
          control="OP-DETERMINACY"
          explanation={t(words.en, words.ar)}
          controlLabel={t('Control', 'الضابط')}
        />
      ) : (
        <p role="status" className="rounded-card border border-line bg-surface px-4 py-3 text-[14px] text-ink-quiet">
          {t(words.en, words.ar)}
        </p>
      )}
      {!development || institutions.length > 0 ? (
        <SingleSignOnCard
          institutions={institutions}
          action={singleSignOnAction}
          segment={segment}
          arabic={arabic}
          stepUp={false}
        />
      ) : null}
      {development ? (
        <Card>
          <form action={signInAction} className="flex flex-col gap-6">
            <input type="hidden" name="locale" value={segment} />
            <label className={FIELD_LABEL}>
              {t('Platform operations token', 'رمز عمليات المنصة')}
              <input
                name="token"
                type="password"
                autoComplete="off"
                required
                className={`${FIELD_INPUT} identifier`}
              />
            </label>
            <div className="flex justify-end">
              <button type="submit" className={BUTTON_PRIMARY}>
                {t('Sign in', 'دخول')}
              </button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
