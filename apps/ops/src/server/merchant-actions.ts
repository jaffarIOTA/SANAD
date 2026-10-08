'use server';

/**
 * Server actions for the merchants screen. Plain form posts and redirects;
 * a refusal travels back as a control code and a reason, never a generic
 * failure. No rule lives here: the domain decides and the database records.
 *
 * Who acts is the signed-in principal (`authorise()`), and the tenant is that
 * principal's; neither ever comes from the form.
 */

import { redirect } from 'next/navigation';

import { changeMerchant, onboardMerchant, verifyMerchant } from './merchants.ts';
import { authorise, localeSegmentOf } from './session.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (form: FormData): string => localeSegmentOf(field(form, 'locale') || 'en');

function back(locale: string, params: Readonly<Record<string, string>>): never {
  redirect(`/${locale}/merchants?${new URLSearchParams(params).toString()}`);
}

export async function onboardMerchantAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const staff = await authorise(locale, 'MERCHANT_ONBOARD', `/${locale}/merchants`);
  const partner = field(form, 'introducedByPartnerRef');
  const result = await onboardMerchant(
    {
      commercialRegistration: field(form, 'commercialRegistration'),
      legalNameAr: field(form, 'legalNameAr'),
      legalNameEn: field(form, 'legalNameEn'),
      categoryCode: field(form, 'categoryCode'),
      settlementAccountRef: field(form, 'settlementAccountRef'),
      ...(partner === '' ? {} : { introducedByPartnerRef: partner }),
    },
    staff,
  );
  if (!result.ok)
    back(locale, { control: result.error.control, message: result.error.detail, reason: result.error.reason });
  back(locale, { done: 'ONBOARDING_BEGUN', merchant: result.ok ? result.value.core.merchantId : '' });
}

export async function verifyMerchantAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const staff = await authorise(locale, 'MERCHANT_VERIFY', `/${locale}/merchants`);
  const merchantId = field(form, 'merchantId');
  const registryStatus = field(form, 'registryStatus');
  const screeningOutcome = field(form, 'screeningOutcome');
  const result = await verifyMerchant(
    merchantId,
    {
      agreementRef: field(form, 'agreementRef'),
      registryLookupRef: field(form, 'registryLookupRef'),
      registryStatus: registryStatus === 'SUSPENDED' || registryStatus === 'CLOSED' ? registryStatus : 'ACTIVE',
      screeningResultRef: field(form, 'screeningResultRef'),
      screeningOutcome:
        screeningOutcome === 'REFER' || screeningOutcome === 'REJECT' || screeningOutcome === 'PENDING_INVESTIGATION'
          ? screeningOutcome
          : 'CLEAR',
      activityPermitted: form.get('activityPermitted') === 'on',
    },
    staff,
  );
  if (!result.ok)
    back(locale, {
      control: result.error.control,
      message: result.error.detail,
      reason: result.error.reason,
      merchant: merchantId,
    });
  back(locale, { done: 'VERIFIED', merchant: merchantId });
}

export async function changeMerchantAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const staff = await authorise(locale, 'MERCHANT_CHANGE', `/${locale}/merchants`);
  const merchantId = field(form, 'merchantId');
  const change = field(form, 'change');
  if (change !== 'SUSPEND' && change !== 'REINSTATE' && change !== 'CLOSE')
    back(locale, { control: 'OP-DETERMINACY', message: 'Unknown change.', reason: 'CHANGE_UNKNOWN' });
  const result = await changeMerchant(
    merchantId,
    change as 'SUSPEND' | 'REINSTATE' | 'CLOSE',
    field(form, 'reason'),
    staff,
  );
  if (!result.ok)
    back(locale, {
      control: result.error.control,
      message: result.error.detail,
      reason: result.error.reason,
      merchant: merchantId,
    });
  back(locale, { done: change, merchant: merchantId });
}
