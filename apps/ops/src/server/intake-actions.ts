'use server';

/**
 * Server actions for the SME intake and KYB screens (stages 1–4).
 *
 * As for the application actions (business-actions.ts): who acts is the
 * signed-in principal, read from the sealed session by `authorise()`, never
 * from the form; each act needs its authority; the tenant comes from the
 * session; the screen returned to is a fixed path, never one from the form;
 * and a refusal goes back as its codes only, worded by the screen.
 *
 * Nothing a check finds is typed here: the registry, identity and screening
 * answers come from the rails. The officer keys only what no rail knows — the
 * licence number, the request, who the parties are and what they own, and the
 * reference of each consent form.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import type { IntakeConsentType, PartyRole } from '@sanad/core/origination/business-intake.ts';

import type { WorkbenchAct } from './authority.ts';
import {
  type OpenIntakeForm,
  clearReferral,
  declareOwners,
  handOverIntake,
  openIntakeFor,
  recordIntakeConsent,
  runIdentityCheck,
  runRegistryCheck,
  runScreening,
  runTaxCheck,
  withdrawIntakeFor,
} from './intake.ts';
import { authorise, localeSegmentOf } from './session.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

interface Context {
  readonly locale: string;
  readonly tenant: TenantCode;
  readonly intakeId: string;
  readonly path: string;
  readonly actor: string;
}

const INTAKE_ID = /^INT-[0-9]{6,10}$/;

async function contextOf(form: FormData, act: WorkbenchAct): Promise<Context> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const raw = field(form, 'intakeId');
  const intakeId = INTAKE_ID.test(raw) ? raw : '';
  const path = intakeId === '' ? `/${locale}/business/intake/new` : `/${locale}/business/intake/${intakeId}`;
  const staff = await authorise(locale, act, path);
  return { locale, tenant: staff.tenantId, intakeId, path, actor: staff.principalId };
}

const refusalQuery = (control: string, reason: string): string => new URLSearchParams({ control, reason }).toString();

async function finish<T>(
  ctx: Context,
  change: () => Promise<Result<T>>,
  notice: string,
  onwards?: (value: T) => string,
): Promise<never> {
  const result = await change();
  revalidatePath(`/${ctx.locale}/business`);
  if (ctx.intakeId !== '') revalidatePath(ctx.path);
  if (!result.ok) redirect(`${ctx.path}?${refusalQuery(result.error.control, result.error.reason)}`);
  const to = onwards === undefined ? ctx.path : onwards(result.value);
  redirect(`${to}?${new URLSearchParams({ notice }).toString()}`);
}

function refused(reason: string): () => Promise<Result<never>> {
  return () => Promise.resolve({ ok: false, error: { control: 'OP-DETERMINACY', reason, detail: reason } });
}

/** A whole number of minor units from a major-unit amount with up to two decimals. No float. */
function minorUnits(raw: string): bigint | undefined {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(raw.replace(/,/g, ''));
  if (m === null) return undefined;
  return BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

/** A percentage with up to two decimals, as per ten thousand. No float. */
function perTenThousand(raw: string): number | undefined {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw === '' ? '0' : raw);
  if (m === null) return undefined;
  const v = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return v <= 10_000 ? v : undefined;
}

const wholeNumber = (raw: string, max: number): number | undefined =>
  /^\d{1,4}$/.test(raw) && Number(raw) <= max ? Number(raw) : undefined;

const ROLES: readonly PartyRole[] = ['OWNER', 'SIGNATORY', 'OWNER_SIGNATORY'];
const CONSENT_TYPES: readonly IntakeConsentType[] = [
  'IDENTITY_VERIFICATION',
  'SCREENING',
  'CREDIT_BUREAU',
  'ACCOUNT_INFORMATION',
  'DOCUMENT_VERIFICATION',
];

/** Up to this many parties on the opening form (the page draws the same number of rows). */
const INTAKE_PARTY_ROWS = 5;

export async function openIntakeAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const amount = minorUnits(field(form, 'requestedAmount'));
  if (amount === undefined) return finish(ctx, refused('AMOUNT_MALFORMED'), '');
  const tenor = wholeNumber(field(form, 'tenorMonths'), 600);
  const grace = wholeNumber(field(form, 'graceMonths') || '0', 600);
  const years = wholeNumber(field(form, 'yearsInOperation'), 200);
  const contribution = perTenThousand(field(form, 'contributionPercent'));
  if (tenor === undefined || grace === undefined || years === undefined || contribution === undefined)
    return finish(ctx, refused('INTAKE_FIGURE_MALFORMED'), '');
  const parties: OpenIntakeForm['parties'][number][] = [];
  for (let i = 0; i < INTAKE_PARTY_ROWS; i++) {
    const partyRef = field(form, `party_ref_${String(i)}`);
    const displayName = field(form, `party_name_${String(i)}`);
    if (partyRef === '' && displayName === '') continue;
    const role = field(form, `party_role_${String(i)}`) as PartyRole;
    const share = perTenThousand(field(form, `party_share_${String(i)}`));
    if (!ROLES.includes(role) || share === undefined) return finish(ctx, refused('INTAKE_PARTY_MALFORMED'), '');
    parties.push({ partyRef, displayName, role, ownershipPerTenThousand: share });
  }
  const nameAr = field(form, 'businessNameAr');
  const trn = field(form, 'taxRegistrationNumber').replaceAll(/[\s-]/g, '');
  return finish(
    ctx,
    () =>
      openIntakeFor(
        ctx.tenant,
        {
          tradeLicence: field(form, 'tradeLicence'),
          issuingAuthority: field(form, 'issuingAuthority'),
          businessNameEn: field(form, 'businessNameEn'),
          ...(nameAr === '' ? {} : { businessNameAr: nameAr }),
          ...(trn === '' ? {} : { taxRegistrationNumber: trn }),
          sector: field(form, 'sector'),
          yearsInOperation: years,
          productCode: field(form, 'productCode'),
          variantCode: field(form, 'variantCode'),
          purpose: field(form, 'purpose'),
          requestedMinorUnits: amount,
          tenorMonths: tenor,
          graceMonths: grace,
          contributionPerTenThousand: contribution,
          parties,
        },
        ctx.actor,
      ),
    'INTAKE_OPENED',
    (intake) => `/${ctx.locale}/business/intake/${intake.intakeId}`,
  );
}

export async function intakeConsentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const type = field(form, 'type') as IntakeConsentType;
  if (!CONSENT_TYPES.includes(type)) return finish(ctx, refused('CONSENT_TYPE_UNKNOWN'), '');
  return finish(
    ctx,
    () =>
      recordIntakeConsent(
        ctx.tenant,
        ctx.intakeId,
        { type, subject: field(form, 'subject'), evidenceRef: field(form, 'evidenceRef') },
        ctx.actor,
      ),
    'CONSENT_RECORDED',
  );
}

export async function registryCheckAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => runRegistryCheck(ctx.tenant, ctx.intakeId, ctx.actor), 'REGISTRY_CHECKED');
}

export async function taxCheckAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => runTaxCheck(ctx.tenant, ctx.intakeId, ctx.actor), 'TAX_REGISTRATION_CHECKED');
}

export async function identityCheckAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => runIdentityCheck(ctx.tenant, ctx.intakeId, field(form, 'partyRef'), ctx.actor),
    'IDENTITY_CHECKED',
  );
}

export async function screeningAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => runScreening(ctx.tenant, ctx.intakeId, field(form, 'subject'), ctx.actor), 'SCREENED');
}

export async function clearReferralAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_KYB_CLEAR');
  return finish(
    ctx,
    () => clearReferral(ctx.tenant, ctx.intakeId, field(form, 'subject'), field(form, 'reason'), ctx.actor),
    'SCREENING_REFERRAL_CLEARED',
  );
}

export async function declareOwnersAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const uboRefs = form.getAll('ubo').filter((v): v is string => typeof v === 'string');
  return finish(
    ctx,
    () =>
      declareOwners(
        ctx.tenant,
        ctx.intakeId,
        { declaredBy: field(form, 'declaredBy'), evidenceRef: field(form, 'evidenceRef'), uboRefs },
        ctx.actor,
      ),
    'BENEFICIAL_OWNERS_DECLARED',
  );
}

export async function handOverIntakeAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => handOverIntake(ctx.tenant, ctx.intakeId, ctx.actor),
    'HANDED_TO_ASSESSMENT',
    (r) => `/${ctx.locale}/business/${encodeURIComponent(r.applicationId)}`,
  );
}

export async function withdrawIntakeAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => withdrawIntakeFor(ctx.tenant, ctx.intakeId, field(form, 'reason'), ctx.actor),
    'INTAKE_WITHDRAWN',
  );
}
