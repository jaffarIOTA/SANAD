/**
 * Sign in through the institution's identity provider: pick the institution,
 * continue to its sign-in. Used by the workbench and Admin alike.
 *
 * The choice only selects whose identity provider and group mappings apply;
 * the server seals it before the redirect and never takes a tenant from the
 * browser after authentication. Arabic first; logical properties only.
 */

import type { ReactElement } from 'react';

import { BUTTON_PRIMARY, CHOICE_CARD, Card } from './primitives.tsx';

export interface SingleSignOnInstitutionChoice {
  readonly tenant: string;
  readonly nameEn: string;
  readonly nameAr: string;
}

export function SingleSignOnCard({
  institutions,
  action,
  segment,
  arabic,
  stepUp,
}: {
  readonly institutions: readonly SingleSignOnInstitutionChoice[];
  readonly action: (form: FormData) => Promise<void>;
  readonly segment: string;
  readonly arabic: boolean;
  /** A fresh authentication is needed before an approval: the provider is asked to authenticate again. */
  readonly stepUp: boolean;
}): ReactElement {
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  if (institutions.length === 0)
    return (
      <Card>
        <h2 className="text-[16px] font-semibold text-heading">
          {t('No institution is set up for single sign-on', 'لا توجد مؤسسة مهيأة للدخول الموحد')}
        </h2>
        <p className="mt-2 text-[14px] text-ink-quiet">
          {t(
            'No institution active in this deployment has an identity provider configured in its staff identity configuration, so nobody can sign in here yet.',
            'لا توجد مؤسسة مفعّلة في هذه البيئة لديها مزوّد هوية مهيأ في إعدادات هوية الموظفين، لذا لا يمكن لأحد تسجيل الدخول هنا بعد.',
          )}
        </p>
      </Card>
    );
  return (
    <Card>
      <form action={action} className="flex flex-col gap-6" data-single-sign-on>
        <input type="hidden" name="locale" value={segment} />
        {stepUp ? <input type="hidden" name="stepUp" value="1" /> : null}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-[16px] font-semibold text-heading">{t('Your institution', 'مؤسستك')}</legend>
          {institutions.map((x, i) => (
            <label key={x.tenant} className={CHOICE_CARD}>
              <input
                type="radio"
                name="institution"
                value={x.tenant}
                required
                defaultChecked={i === 0 && institutions.length === 1}
                className="mt-1 size-4 accent-brand"
              />
              <span className="flex flex-col">
                <span className="text-[15px] font-medium text-heading">{arabic ? x.nameAr : x.nameEn}</span>
                <bdi dir="ltr" className="identifier text-[13px] text-ink-quiet">
                  {x.tenant}
                </bdi>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-[13px] text-ink-quiet">
          {t(
            'You will sign in at your institution’s identity provider. What you may do here comes from your groups there, as your institution’s staff identity configuration maps them.',
            'ستسجّل الدخول لدى مزوّد الهوية في مؤسستك. وتُستمد صلاحياتك هنا من مجموعاتك لديه وفق إعدادات هوية الموظفين لدى مؤسستك.',
          )}
        </p>
        <div className="flex justify-end">
          <button type="submit" className={BUTTON_PRIMARY}>
            {stepUp
              ? t('Authenticate again', 'إعادة التحقق من الهوية')
              : t('Continue to your institution’s sign-in', 'المتابعة إلى دخول مؤسستك')}
          </button>
        </div>
      </form>
    </Card>
  );
}
