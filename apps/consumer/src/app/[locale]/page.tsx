/**
 * Sign in through the national digital identity. The applicant is known to
 * the platform by a reference; the identity rail returns an assertion, and
 * that assertion — not a name, not an identifier — is what an acceptance is
 * later bound to.
 */

import { notFound, redirect } from 'next/navigation';

import { Card, ControlRejection } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { signInAction } from '../../server/actions.ts';
import { explain } from '../../server/explain.ts';
import { demonstrationSignInPermitted } from '../../server/identity.ts';
import { currentSession } from '../../server/session.ts';

export default async function SignInPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly refused?: string; readonly control?: string; readonly next?: string }>;
}) {
  const { locale: segment } = await params;
  const { refused, control, next } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  if ((await currentSession()) !== undefined)
    redirect(next !== undefined && next.startsWith(`/${segment}/`) ? next : `/${segment}/apply`);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-h1 font-semibold text-heading">{arabic ? 'تمويلك، بوضوح' : 'Finance, disclosed'}</h1>
        <p className="mt-2 text-[15px] text-ink-quiet">
          {arabic
            ? 'ادخل بهويتك الوطنية الرقمية. لا نطلب رقم هويتك هنا؛ يعود إلينا مرجع التحقق فقط.'
            : 'Sign in with your national digital identity. We do not ask for your identifier here; only the verification reference comes back to us.'}
        </p>
      </div>
      {refused !== undefined ? (
        <ControlRejection
          control={control ?? 'OP-DETERMINACY'}
          explanation={explain(refused, arabic)}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}
      {(await demonstrationSignInPermitted()) ? (
        <SignInForm segment={segment} next={next} arabic={arabic} />
      ) : (
        <Card>
          <p className="text-[15px] text-ink">{explain('IDENTITY_PROVIDER_NOT_CONFIGURED', arabic)}</p>
        </Card>
      )}
    </div>
  );
}

function SignInForm({
  segment,
  next,
  arabic,
}: {
  readonly segment: string;
  readonly next: string | undefined;
  readonly arabic: boolean;
}) {
  return (
    <Card>
      <form action={signInAction} className="flex flex-col gap-4">
        <input type="hidden" name="locale" value={segment} />
        {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
        <label className="flex flex-col gap-1 text-sm font-medium text-ink">
          {arabic ? 'مرجع المتقدّم (بيئة تطوير)' : 'Applicant reference (development)'}
          <input
            name="applicantRef"
            defaultValue="applicant-demo"
            pattern="[a-z0-9-]{3,40}"
            required
            className="identifier h-[50px] rounded-pill bg-field ps-5 pe-4 text-base outline-none focus:ring-2 focus:ring-brand/40"
          />
        </label>
        <button
          type="submit"
          className="press inline-flex min-h-tap items-center justify-center rounded-pill bg-brand px-6 text-base font-semibold text-white hover:bg-brand-deep"
        >
          {arabic ? 'الدخول عبر الهوية الوطنية' : 'Continue with national identity'}
        </button>
        <p className="text-xs text-ink-quiet">
          {arabic
            ? 'في الإنتاج تفتح هذه الخطوة تطبيق نفاذ. هنا بديل تطويري يعيد مرجع تحقق فوراً.'
            : 'In production this opens the national identity app. Here a development stand-in returns a verification reference at once.'}
        </p>
      </form>
    </Card>
  );
}
