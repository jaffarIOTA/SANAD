/**
 * Sign in to the operations workbench.
 *
 * Production: the institution's single sign-on by OpenID Connect. The page
 * lists the institutions active in this deployment's jurisdiction whose staff
 * identity configuration uses OIDC; the person picks theirs and continues to
 * its identity provider. No development path is offered (the action refuses
 * it too).
 *
 * Development: a member of staff's own token from the local environment,
 * compared by digest on the server; one token is one person. Single sign-on is
 * offered as well wherever an institution's configuration in force uses OIDC.
 *
 * Arabic first; every word on the page in both languages.
 */

import { notFound } from 'next/navigation';

import { BUTTON_PRIMARY, Card, ControlRejection, FIELD_INPUT, FIELD_LABEL } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { SingleSignOnCard } from '@sanad/design/SingleSignOn.tsx';
import { singleSignOnInstitutions } from '@sanad/origination/staff-identity.ts';

import { signInAction, singleSignOnAction } from '../../../server/auth-actions.ts';
import { authorityLabel } from '../../../server/authority.ts';
import { currentStaffSession } from '../../../server/session.ts';
import { developmentTokensPermitted } from '../../../server/staff.ts';
import { epochNow } from '../../../server/staff-session.ts';

type Words = { readonly en: string; readonly ar: string; readonly refusal: boolean };

const REASONS: Readonly<Record<string, Words>> = {
  SESSION_REQUIRED: {
    en: 'Sign in to continue. A session ends a fixed time after sign-in, whatever the activity.',
    ar: 'سجّل الدخول للمتابعة. تنتهي الجلسة بعد مدة محددة من تسجيل الدخول أياً كان النشاط.',
    refusal: false,
  },
  SIGNED_OUT: { en: 'You are signed out.', ar: 'تم تسجيل خروجك.', refusal: false },
  SIGN_IN_REFUSED: {
    en: 'Your sign-in was not recognised, or it grants no authority under your institution’s staff identity configuration.',
    ar: 'لم يُتعرَّف على تسجيل دخولك، أو أنه لا يمنح أي صلاحية وفق إعدادات هوية الموظفين لدى مؤسستك.',
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
  STEP_UP_REQUIRED: {
    en: 'This decision needs a recent authentication. Sign in again to confirm it is you, then repeat the action.',
    ar: 'يتطلب هذا القرار تحققاً حديثاً من الهوية. سجّل الدخول مجدداً لتأكيد هويتك، ثم أعد تنفيذ الإجراء.',
    refusal: false,
  },
  TENANT_NOT_ACTIVE: {
    en: 'Your institution is not active in the jurisdiction this deployment runs as. Nothing can be done in its name here.',
    ar: 'مؤسستك غير مفعّلة في الولاية التي يعمل بها هذا التطبيق، فلا يُنفَّذ أي إجراء باسمها هنا.',
    refusal: true,
  },
  DEVELOPMENT_SIGN_IN_REFUSED: {
    en: 'Development tokens are refused in production. Staff sign in through the institution’s single sign-on.',
    ar: 'رموز التطوير مرفوضة في بيئة الإنتاج. يسجّل الموظفون الدخول عبر نظام الدخول الموحد للمؤسسة.',
    refusal: true,
  },
};

export default async function SignInPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly reason?: string }>;
}) {
  const { locale: segment } = await params;
  const { reason } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const words = reason === undefined ? undefined : REASONS[reason];
  const session = await currentStaffSession();
  const staff = session?.principal;
  const production = !developmentTokensPermitted();
  const institutions = await singleSignOnInstitutions(epochNow());

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6" data-sign-in>
      <div>
        <h1 className="text-h1 font-bold tracking-tight text-heading">{t('Sign in', 'تسجيل الدخول')}</h1>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {t(
            'The operations workbench acts as the person signed in. Four eyes is between people: whoever keys a figure, presents a document or submits a case is not the one who checks or decides it.',
            'تعمل منصة العمليات باسم الشخص الذي سجّل الدخول. مبدأ العيون الأربع بين أشخاص: من يُدخل الرقم أو يقدّم المستند أو يحيل الطلب ليس من يتحقق منه أو يبتّ فيه.',
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

      {staff === undefined ? null : (
        <Card>
          <p className="text-[14px] text-ink">
            {t('Signed in as', 'مسجّل الدخول باسم')}{' '}
            {session?.displayName === undefined ? null : (
              <>
                <bdi className="font-semibold">{session.displayName}</bdi>{' '}
              </>
            )}
            <bdi dir="ltr" className="identifier font-semibold">
              {staff.principalId}
            </bdi>{' '}
            ·{' '}
            <bdi dir="ltr" className="identifier">
              {staff.tenantId}
            </bdi>{' '}
            · {staff.authorities.map((a) => authorityLabel(a, arabic)).join(arabic ? '، ' : ', ')}
          </p>
          <a href={`/${segment}`} className="mt-3 inline-flex text-[14px] font-semibold text-brand hover:underline">
            {t('Continue to the workbench', 'المتابعة إلى منصة العمليات')}
          </a>
        </Card>
      )}

      {production || institutions.length > 0 ? (
        <SingleSignOnCard
          institutions={institutions}
          action={singleSignOnAction}
          segment={segment}
          arabic={arabic}
          stepUp={reason === 'STEP_UP_REQUIRED'}
        />
      ) : null}

      {production ? null : (
        <Card>
          <form action={signInAction} className="flex flex-col gap-6">
            <input type="hidden" name="locale" value={segment} />
            <label className={FIELD_LABEL}>
              {t('Your staff token', 'رمز الموظف الخاص بك')}
              <input name="token" type="password" autoComplete="off" required className={`${FIELD_INPUT} identifier`} />
            </label>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'Development only: the token is your own, from your local environment file. It names one person in one institution; what you may do comes from that institution’s staff identity configuration.',
                'لبيئة التطوير فقط: الرمز خاص بك من ملف البيئة المحلي. يحدد شخصاً واحداً في مؤسسة واحدة، وتُستمد صلاحياتك من إعدادات هوية الموظفين لدى تلك المؤسسة.',
              )}
            </p>
            <div className="flex justify-end">
              <button type="submit" className={BUTTON_PRIMARY}>
                {t('Sign in', 'دخول')}
              </button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
