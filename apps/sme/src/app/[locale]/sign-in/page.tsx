/**
 * Sign in to the SME portal (Wasl W3): an authorised signatory of a
 * distributor, through the national digital identity service.
 *
 * The person enters their party reference; the identity service's app asks
 * them to approve; they continue here and the session names the distributor
 * they sign for — from the bank's configuration, never from the form. Where
 * the identity service cannot be used, the page says so and offers nothing.
 *
 * On the synthetic environment the identity service is the demonstration
 * transport, and the page says that too: any configured signatory reference
 * signs in without a real person approving.
 */
import { notFound, redirect } from 'next/navigation';

import { Card, ControlRejection } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { confirmSignInAction, startSignInAction } from '../../../server/actions.ts';
import { signInAvailable } from '../../../server/portal.ts';
import { currentSession, pendingKind } from '../../../server/session.ts';
import { NOTICE, REFUSAL, say } from '../words.ts';

export default async function SignInPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly control?: string; readonly reason?: string; readonly notice?: string }>;
}) {
  const { locale: segment } = await params;
  const { control, reason, notice } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  if ((await currentSession()) !== undefined) redirect(`/${segment}`);
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const available = await signInAvailable();
  const waiting = (await pendingKind()) === 'SIGN_IN';

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold">{t('Sign in', 'تسجيل الدخول')}</h1>
        <p className="mt-1 text-sm text-ink-quiet">
          {t(
            'For people authorised to sign for a distributor. You sign in with the national identity service; the bank’s records say which company you act for.',
            'للمفوّضين بالتوقيع عن الموزّع. تسجّل الدخول عبر خدمة الهوية الوطنية، وتحدّد سجلات البنك المنشأة التي تمثّلها.',
          )}
        </p>
      </div>

      {control === undefined ? null : (
        <ControlRejection
          control={control}
          explanation={say(REFUSAL, reason, arabic) ?? t('Sign-in was refused.', 'رُفض تسجيل الدخول.')}
          controlLabel={t('Control', 'الضابط')}
        />
      )}

      {!available ? (
        <Card>
          <p className="text-sm text-ink">
            {t(
              'The national identity service is not connected here, so no one can sign in yet.',
              'خدمة الهوية الوطنية غير متصلة هنا، لذا لا يمكن تسجيل الدخول بعد.',
            )}
          </p>
        </Card>
      ) : waiting ? (
        <Card>
          <p role="status" className="text-sm text-ink">
            {say(NOTICE, notice ?? 'APPROVE_IN_APP', arabic)}
          </p>
          <form action={confirmSignInAction} className="mt-4">
            <input type="hidden" name="locale" value={segment} />
            <button
              type="submit"
              className="press min-h-tap w-full rounded-tile bg-brand-deep px-6 text-base font-medium text-white"
            >
              {t('I have approved — continue', 'وافقت — متابعة')}
            </button>
          </form>
        </Card>
      ) : (
        <Card>
          <form action={startSignInAction} className="flex flex-col gap-3">
            <input type="hidden" name="locale" value={segment} />
            <label className="flex flex-col gap-2">
              <span className="text-sm text-ink">{t('Your signatory reference', 'مرجعك كمفوّض بالتوقيع')}</span>
              <input
                name="signatoryRef"
                required
                maxLength={64}
                autoComplete="username"
                dir="ltr"
                className="identifier min-h-tap rounded-tile border border-line-strong bg-surface px-4 text-base"
              />
            </label>
            <button
              type="submit"
              className="press min-h-tap rounded-tile bg-brand-deep px-6 text-base font-medium text-white"
            >
              {t('Sign in with the national identity service', 'الدخول عبر خدمة الهوية الوطنية')}
            </button>
          </form>
          <p className="mt-3 rounded-tile border border-attention/40 bg-attention-wash px-3 py-2 text-xs text-attention">
            {t(
              'Demonstration environment: the identity service is simulated and the data is synthetic. A configured reference such as sig-rawabi-01 signs in without a real approval.',
              'بيئة تجريبية: خدمة الهوية محاكاة والبيانات اصطناعية. يدخل مرجع مُعدّ مثل sig-rawabi-01 دون موافقة فعلية.',
            )}
          </p>
        </Card>
      )}
    </div>
  );
}
