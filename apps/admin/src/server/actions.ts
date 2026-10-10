'use server';

/**
 * The administration actions. Plain form posts and redirects. The secret
 * field is read once and handed to the store; it is not echoed into a
 * redirect, a log or an error.
 */

import { redirect } from 'next/navigation';

import {
  ENVIRONMENTS,
  type Environment,
  VAULT_PROVIDERS,
  type VaultProvider,
  listCredentials,
  revokeCredential,
  saveCredential,
  store,
} from './credentials.ts';
import { catalogueWithAddition, catalogueWithChange, checkProposal, resolveProductCatalogue } from './products.ts';
import { decideRevision, listRevisions, proposeRevision } from './revisions.ts';
import { railsWithChange, resolveRailsConfiguration } from './rails.ts';
import { parseRailsConfiguration } from '@sanad/core/config/rails.ts';
import { ADAPTER_CATALOGUE } from '@sanad/adapters/catalogue.ts';
import { type RevisionArea, proposeRevision as proposePure } from '@sanad/core/config/revision.ts';
import { deploymentProfile, identityFromForm, resolveStaffIdentity } from './identity.ts';
import { parseStaffIdentity } from '@sanad/core/config/staff-identity.ts';
import { policyWithPartner, resolveOriginationPolicy } from './partners.ts';
import { parseOriginationPolicy } from '@sanad/core/origination/policy.ts';
import { catalogueForTenant, loadProductCatalogue } from '@sanad/config/loader.ts';
import { randomUUID } from 'node:crypto';
import {
  currentAdmin,
  developmentPrincipalFor,
  developmentSignInPermitted,
  endAdminSession,
  startAdminSession,
} from './session.ts';
import { beginSingleSignOn, providerSignOut } from './single-sign-on.ts';
import { configurableTenant } from './tenant-scope.ts';
import { decideDeploymentJurisdiction, proposeDeploymentJurisdiction } from '@sanad/origination/jurisdiction.ts';
import { decideLicenceInstall, proposeLicenceInstall } from '@sanad/origination/licensing.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const back = (to: string, notice: string): never =>
  redirect(`${to}${to.includes('?') ? '&' : '?'}notice=${encodeURIComponent(notice)}`);

export async function signInAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  if (!developmentSignInPermitted()) return back(`/${locale}`, 'DEVELOPMENT_SIGN_IN_REFUSED');
  const principal = developmentPrincipalFor(field(form, 'token'));
  if (principal === undefined) return back(`/${locale}`, 'SIGN_IN_REFUSED');
  // The session lifetime is the tenant's staff identity configuration in force, bounded by the session layer.
  const identity = await resolveStaffIdentity('bank-a', nowEpoch());
  await startAdminSession(
    principal,
    identity.identity.ok ? BigInt(identity.identity.value.sessionLifetimeSeconds) : undefined,
  );
  redirect(`/${locale}/credentials`);
}

/**
 * Begin single sign-on at the chosen institution's identity provider. The
 * choice is made before authentication and only selects whose provider and
 * mappings apply; it must be one the page lists.
 */
export async function singleSignOnAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') === 'en' ? 'en' : 'ar';
  const begun = await beginSingleSignOn(field(form, 'institution'), locale);
  if (!begun.ok) return back(`/${locale}`, begun.notice);
  redirect(begun.location);
}

export async function signOutAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') === 'en' ? 'en' : 'ar';
  const admin = await currentAdmin();
  await endAdminSession();
  if (admin?.method === 'OIDC' && admin.tenantId !== undefined) {
    const atProvider = await providerSignOut(admin.tenantId, locale);
    if (atProvider !== undefined) redirect(atProvider);
  }
  redirect(`/${locale}`);
}

export async function saveCredentialAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenantCode = configurableTenant(admin, field(form, 'tenant'));
  if (tenantCode === undefined) return back(`/${locale}/credentials`, 'TENANT_UNKNOWN');
  const to = `/${locale}/credentials?tenant=${encodeURIComponent(tenantCode)}`;
  const s = store();
  if (s.kind !== 'READY') back(to, 'NO_DATABASE');
  const provider = field(form, 'provider');
  const environment = field(form, 'environment');
  const keyName = field(form, 'keyName');
  const secret = form.get('secret');
  const label = field(form, 'label');
  if (!(VAULT_PROVIDERS as readonly string[]).includes(provider)) back(to, 'PROVIDER_UNKNOWN');
  if (!(ENVIRONMENTS as readonly string[]).includes(environment)) back(to, 'ENVIRONMENT_UNKNOWN');
  // A vendor's own spelling is allowed (tenantCode, csrfToken); an adapter documents the names it reads.
  if (!/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(keyName)) back(to, 'KEY_NAME_MALFORMED');
  if (typeof secret !== 'string' || secret.trim().length === 0) back(to, 'SECRET_EMPTY');
  if (s.kind !== 'READY' || typeof secret !== 'string') return;
  try {
    await saveCredential(s.pool, {
      tenantCode,
      provider: provider as VaultProvider,
      environment: environment as Environment,
      keyName,
      secret: secret.trim(),
      ...(label === '' ? {} : { label }),
    });
  } catch {
    back(to, 'SAVE_FAILED');
  }
  back(to, 'SAVED');
}

export async function revokeCredentialAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenantCode = configurableTenant(admin, field(form, 'tenant'));
  if (tenantCode === undefined) return back(`/${locale}/credentials`, 'TENANT_UNKNOWN');
  const to = `/${locale}/credentials?tenant=${encodeURIComponent(tenantCode)}`;
  const s = store();
  if (s.kind !== 'READY') back(to, 'NO_DATABASE');
  const id = field(form, 'credentialId');
  if (!/^[0-9a-f-]{36}$/i.test(id)) back(to, 'CREDENTIAL_ID_MALFORMED');
  if (field(form, 'confirm') !== 'yes') back(to, 'CONFIRMATION_REQUIRED');
  if (s.kind !== 'READY') return;
  // Only this institution's credential: another's identifier is absent here.
  if (!(await listCredentials(s.pool, tenantCode)).some((c) => c.id === id)) return back(to, 'REVOKE_FAILED');
  try {
    await revokeCredential(s.pool, id);
  } catch {
    back(to, 'REVOKE_FAILED');
  }
  back(to, 'REVOKED');
}

const nowEpoch = (): bigint => BigInt(Math.floor(Date.now() / 1000));

export async function proposeProductChangeAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenant = configurableTenant(admin, field(form, 'tenant'));
  if (tenant === undefined) return back(`/${locale}/products`, 'TENANT_UNKNOWN');
  const to = `/${locale}/products?tenant=${encodeURIComponent(tenant)}`;
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const now = nowEpoch();
  const current = await resolveProductCatalogue(tenant, now);
  if (!current.catalogue.ok) return back(to, 'CATALOGUE_UNREADABLE');
  const effectiveRaw = field(form, 'effectiveFrom');
  const effectiveMs = effectiveRaw === '' ? Date.now() : Date.parse(effectiveRaw);
  if (!Number.isFinite(effectiveMs)) return back(to, 'EFFECTIVE_FROM_MALFORMED');
  const boardRulingRef = field(form, 'boardRulingRef');
  const coreBankingProductCode = field(form, 'coreBankingProductCode');
  const changed = catalogueWithChange(current.catalogue.value, {
    productCode: field(form, 'productCode'),
    enabled: form.get('enabled') === 'on',
    termsJson: field(form, 'terms'),
    ...(boardRulingRef === '' ? {} : { boardRulingRef }),
    coreBankingProductCode,
  });
  if (!changed.ok) return back(to, `REFUSED:${changed.error.reason}`);
  const summary = field(form, 'summary');
  const checked = checkProposal({
    tenant,
    payload: changed.value.payload,
    summary,
    effectiveFromEpochSeconds: BigInt(Math.floor(effectiveMs / 1000)),
    proposedBy: admin?.principalId ?? '',
    nowEpochSeconds: now,
  });
  if (!checked.ok) return back(to, `REFUSED:${checked.error.reason}`);
  try {
    await proposeRevision(s.pool, {
      tenantCode: tenant,
      area: 'PRODUCTS',
      payload: changed.value.payload,
      summary,
      effectiveFromEpochSeconds: BigInt(Math.floor(effectiveMs / 1000)),
      proposedBy: admin?.principalId ?? '',
      correlationId: randomUUID(),
    });
  } catch {
    return back(to, 'PROPOSE_FAILED');
  }
  back(to, 'PROPOSED');
}

/** Propose adding a shipped product module to the catalogue, from the tenant's checked-in term sheet. A second administrator approves it. */
export async function proposeProductAdditionAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenant = configurableTenant(admin, field(form, 'tenant'));
  if (tenant === undefined) return back(`/${locale}/products`, 'TENANT_UNKNOWN');
  const to = `/${locale}/products?tenant=${encodeURIComponent(tenant)}`;
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const now = nowEpoch();
  const current = await resolveProductCatalogue(tenant, now);
  if (!current.catalogue.ok) return back(to, 'CATALOGUE_UNREADABLE');
  const template = loadProductCatalogue(tenant);
  if (!template.ok) return back(to, 'CATALOGUE_UNREADABLE');
  const productCode = field(form, 'productCode');
  const added = catalogueWithAddition(current.catalogue.value, template.value, productCode);
  if (!added.ok) return back(to, `REFUSED:${added.error.reason}`);
  const summary = `Add ${productCode} to the catalogue, from the checked-in term sheet`;
  const checked = checkProposal({
    tenant,
    payload: added.value.payload,
    summary,
    effectiveFromEpochSeconds: now,
    proposedBy: admin?.principalId ?? '',
    nowEpochSeconds: now,
  });
  if (!checked.ok) return back(to, `REFUSED:${checked.error.reason}`);
  try {
    await proposeRevision(s.pool, {
      tenantCode: tenant,
      area: 'PRODUCTS',
      payload: added.value.payload,
      summary,
      effectiveFromEpochSeconds: now,
      proposedBy: admin?.principalId ?? '',
      correlationId: randomUUID(),
    });
  } catch {
    return back(to, 'PROPOSE_FAILED');
  }
  back(to, 'PROPOSED');
}

/** Propose the jurisdiction the whole deployment behaves as (ADR 0005). Another administrator decides. */
export async function proposeJurisdictionAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const to = `/${locale}/jurisdiction`;
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  if (store().kind !== 'READY') return back(to, 'NO_DATABASE');
  const jurisdiction = field(form, 'jurisdiction');
  if (jurisdiction !== 'SA' && jurisdiction !== 'AE') return back(to, 'JURISDICTION_UNKNOWN');
  const summary = field(form, 'summary');
  if (summary.length < 3) return back(to, 'SUMMARY_REQUIRED');
  try {
    await proposeDeploymentJurisdiction({
      jurisdiction,
      summary,
      proposedBy: admin?.principalId ?? '',
      correlationId: randomUUID(),
    });
  } catch (error) {
    const m = error instanceof Error ? error.message : '';
    return back(
      to,
      /does not change/.test(m) ? 'LOCKED' : /already behaves/.test(m) ? 'ALREADY_IN_FORCE' : 'PROPOSE_FAILED',
    );
  }
  back(to, 'PROPOSED');
}

export async function decideJurisdictionAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const to = `/${locale}/jurisdiction`;
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  if (store().kind !== 'READY') return back(to, 'NO_DATABASE');
  const id = field(form, 'revisionId');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(to, 'REVISION_ID_MALFORMED');
  const approve = field(form, 'decision') === 'approve';
  const reason = field(form, 'reason');
  if (!approve && reason.length < 3) return back(to, 'REJECTION_REASON_REQUIRED');
  try {
    await decideDeploymentJurisdiction({
      revisionId: id,
      approve,
      decidedBy: admin?.principalId ?? '',
      ...(approve ? {} : { reason }),
      correlationId: randomUUID(),
    });
  } catch (error) {
    const m = error instanceof Error ? error.message : '';
    return back(
      to,
      /four eyes/.test(m)
        ? 'REFUSED:FOUR_EYES_SELF_DECISION'
        : /does not change/.test(m)
          ? 'LOCKED'
          : /residency/.test(m)
            ? 'RESIDENCY'
            : 'DECIDE_FAILED',
    );
  }
  back(to, approve ? 'APPROVED' : 'REJECTED');
}

const REVISION_AREA_OF_SCREEN = {
  products: 'PRODUCTS',
  rails: 'RAILS',
  identity: 'STAFF_IDENTITY',
  partners: 'ORIGINATION_POLICY',
} as const satisfies Record<string, RevisionArea>;

export async function decideRevisionAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const areaField = field(form, 'area');
  const area = areaField === 'rails' || areaField === 'identity' || areaField === 'partners' ? areaField : 'products';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenant = configurableTenant(admin, field(form, 'tenant'));
  if (tenant === undefined) return back(`/${locale}/${area}`, 'TENANT_UNKNOWN');
  const to = `/${locale}/${area}?tenant=${encodeURIComponent(tenant)}`;
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const id = field(form, 'revisionId');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(to, 'REVISION_ID_MALFORMED');
  // Only this institution's revision, in this screen's area: another's identifier is absent here.
  const revisionArea = REVISION_AREA_OF_SCREEN[area];
  if (!(await listRevisions(s.pool, tenant, revisionArea)).some((r) => r.id === id)) return back(to, 'DECIDE_FAILED');
  const approve = field(form, 'decision') === 'approve';
  const reason = field(form, 'reason');
  if (!approve && reason.length < 3) return back(to, 'REJECTION_REASON_REQUIRED');
  try {
    await decideRevision(s.pool, {
      id,
      decidedBy: admin?.principalId ?? '',
      approve,
      ...(approve ? {} : { reason }),
      correlationId: randomUUID(),
    });
  } catch (error) {
    return back(
      to,
      /FOUR_EYES/.test(error instanceof Error ? error.message : '')
        ? 'REFUSED:FOUR_EYES_SELF_DECISION'
        : 'DECIDE_FAILED',
    );
  }
  back(to, approve ? 'APPROVED' : 'REJECTED');
}

export async function proposeRailChangeAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenant = configurableTenant(admin, field(form, 'tenant'));
  if (tenant === undefined) return back(`/${locale}/rails`, 'TENANT_UNKNOWN');
  const to = `/${locale}/rails?tenant=${encodeURIComponent(tenant)}`;
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const now = nowEpoch();
  const current = await resolveRailsConfiguration(tenant, now);
  if (!current.rails.ok) return back(to, 'RAILS_UNREADABLE');
  const effectiveRaw = field(form, 'effectiveFrom');
  const effectiveMs = effectiveRaw === '' ? Date.now() : Date.parse(effectiveRaw);
  if (!Number.isFinite(effectiveMs)) return back(to, 'EFFECTIVE_FROM_MALFORMED');
  const opt = (name: string): string | undefined => {
    const v = field(form, name);
    return v === '' ? undefined : v;
  };
  const fallback = opt('fallbackAdapter');
  const baseUrl = opt('baseUrl');
  const note = opt('note');
  const catalogue = catalogueForTenant(tenant, ADAPTER_CATALOGUE);
  if (!catalogue.ok) return back(to, `REFUSED:${catalogue.error.reason}`);
  const changed = railsWithChange(
    current.rails.value,
    {
      capability: field(form, 'capability'),
      adapter: field(form, 'adapter'),
      environment: field(form, 'environment'),
      enabled: form.get('enabled') === 'on',
      ...(fallback === undefined ? {} : { fallbackAdapter: fallback }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(note === undefined ? {} : { note }),
    },
    catalogue.value,
  );
  if (!changed.ok) return back(to, `REFUSED:${changed.error.reason}`);
  const summary = field(form, 'summary');
  const effectiveFromEpochSeconds = BigInt(Math.floor(effectiveMs / 1000));
  const checked = proposePure({
    id: randomUUID(),
    tenantId: tenant,
    area: 'RAILS',
    rawPayload: changed.value.payload,
    summary,
    effectiveFromEpochSeconds,
    proposedBy: admin?.principalId ?? '',
    proposedAtEpochSeconds: now,
    parse: (raw) => parseRailsConfiguration(raw, catalogue.value),
  });
  if (!checked.ok) return back(to, `REFUSED:${checked.error.reason}`);
  try {
    await proposeRevision(s.pool, {
      tenantCode: tenant,
      area: 'RAILS',
      payload: changed.value.payload,
      summary,
      effectiveFromEpochSeconds,
      proposedBy: admin?.principalId ?? '',
      correlationId: randomUUID(),
    });
  } catch {
    return back(to, 'PROPOSE_FAILED');
  }
  back(to, 'PROPOSED');
}

export async function proposeIdentityChangeAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenant = configurableTenant(admin, field(form, 'tenant'));
  if (tenant === undefined) return back(`/${locale}/identity`, 'TENANT_UNKNOWN');
  const to = `/${locale}/identity?tenant=${encodeURIComponent(tenant)}`;
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const now = nowEpoch();
  const effectiveRaw = field(form, 'effectiveFrom');
  const effectiveMs = effectiveRaw === '' ? Date.now() : Date.parse(effectiveRaw);
  if (!Number.isFinite(effectiveMs)) return back(to, 'EFFECTIVE_FROM_MALFORMED');
  const opt = (name: string): string | undefined => {
    const v = field(form, name);
    return v === '' ? undefined : v;
  };
  // Checked under the profile the form names, so a configuration meant for deployment is refused now, not on deployment day.
  const profile = field(form, 'profile') === 'DEPLOYED' ? 'DEPLOYED' : deploymentProfile();
  const metadataUrl = opt('metadataUrl');
  const clientId = opt('clientId');
  const stepUp = opt('stepUpForApprovalSeconds');
  const built = identityFromForm(
    {
      protocol: field(form, 'protocol'),
      issuer: field(form, 'issuer'),
      groupsClaim: field(form, 'groupsClaim'),
      mappingsText: field(form, 'mappings'),
      sessionLifetimeSeconds: field(form, 'sessionLifetimeSeconds'),
      version: field(form, 'version') || new Date(effectiveMs).toISOString().slice(0, 10),
      ...(metadataUrl === undefined ? {} : { metadataUrl }),
      ...(clientId === undefined ? {} : { clientId }),
      ...(stepUp === undefined ? {} : { stepUpForApprovalSeconds: stepUp }),
    },
    profile,
  );
  if (!built.ok) return back(to, `REFUSED:${built.error.reason}`);
  const summary = field(form, 'summary');
  const effectiveFromEpochSeconds = BigInt(Math.floor(effectiveMs / 1000));
  const checked = proposePure({
    id: randomUUID(),
    tenantId: tenant,
    area: 'STAFF_IDENTITY',
    rawPayload: built.value.payload,
    summary,
    effectiveFromEpochSeconds,
    proposedBy: admin?.principalId ?? '',
    proposedAtEpochSeconds: now,
    parse: (raw) => parseStaffIdentity(raw, profile),
  });
  if (!checked.ok) return back(to, `REFUSED:${checked.error.reason}`);
  try {
    await proposeRevision(s.pool, {
      tenantCode: tenant,
      area: 'STAFF_IDENTITY',
      payload: built.value.payload,
      summary,
      effectiveFromEpochSeconds,
      proposedBy: admin?.principalId ?? '',
      correlationId: randomUUID(),
    });
  } catch {
    return back(to, 'PROPOSE_FAILED');
  }
  back(to, 'PROPOSED');
}

export async function proposePartnerChangeAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const tenant = configurableTenant(admin, field(form, 'tenant'));
  if (tenant === undefined) return back(`/${locale}/partners`, 'TENANT_UNKNOWN');
  const to = `/${locale}/partners?tenant=${encodeURIComponent(tenant)}`;
  const s = store();
  if (s.kind !== 'READY') return back(to, 'NO_DATABASE');
  const now = nowEpoch();
  const current = await resolveOriginationPolicy(tenant, now);
  if (!current.policy.ok) return back(to, 'POLICY_UNREADABLE');
  const effectiveRaw = field(form, 'effectiveFrom');
  const effectiveMs = effectiveRaw === '' ? Date.now() : Date.parse(effectiveRaw);
  if (!Number.isFinite(effectiveMs)) return back(to, 'EFFECTIVE_FROM_MALFORMED');
  const changed = policyWithPartner(current.policy.value, {
    partnerId: field(form, 'partnerId'),
    status: field(form, 'status'),
    channel: field(form, 'channel'),
    programmesText: field(form, 'programmes'),
    maxRequestMinorUnits: field(form, 'maxRequestMinorUnits').replace(/[^\d]/g, ''),
  });
  if (!changed.ok) return back(to, `REFUSED:${changed.error.reason}`);
  const summary = field(form, 'summary');
  const effectiveFromEpochSeconds = BigInt(Math.floor(effectiveMs / 1000));
  const checked = proposePure({
    id: randomUUID(),
    tenantId: tenant,
    area: 'ORIGINATION_POLICY',
    rawPayload: changed.value.payload,
    summary,
    effectiveFromEpochSeconds,
    proposedBy: admin?.principalId ?? '',
    proposedAtEpochSeconds: now,
    parse: parseOriginationPolicy,
  });
  if (!checked.ok) return back(to, `REFUSED:${checked.error.reason}`);
  try {
    await proposeRevision(s.pool, {
      tenantCode: tenant,
      area: 'ORIGINATION_POLICY',
      payload: changed.value.payload,
      summary,
      effectiveFromEpochSeconds,
      proposedBy: admin?.principalId ?? '',
      correlationId: randomUUID(),
    });
  } catch {
    return back(to, 'PROPOSE_FAILED');
  }
  back(to, 'PROPOSED');
}

/** Licence files are small; anything larger is not one. */
const MAX_LICENCE_FILE_BYTES = 64 * 1024;

/**
 * Propose installing a licence (ADR 0006): one administrator uploads the
 * signed file; it is verified now (signature, term, installation) and held
 * for a different administrator to approve. Never gated on the licence's own
 * state — installing a licence is how a blocked installation recovers.
 */
export async function proposeLicenceAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const to = `/${locale}/licence`;
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const file = form.get('licenceFile');
  if (!(file instanceof Blob) || file.size === 0) return back(to, 'FILE_REQUIRED');
  if (file.size > MAX_LICENCE_FILE_BYTES) return back(to, 'REFUSED:MALFORMED');
  const proposed = await proposeLicenceInstall({ fileText: await file.text(), proposedBy: admin?.principalId ?? '' });
  if (!proposed.ok) return back(to, `REFUSED:${proposed.error.refusal.reason}`);
  back(to, 'PROPOSED');
}

/** Approve (install, re-verified now) or reject a proposed licence. Never by the administrator who proposed it. */
export async function decideLicenceAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const to = `/${locale}/licence`;
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${locale}`);
  const id = field(form, 'proposalId');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(to, 'PROPOSAL_ID_MALFORMED');
  const approve = field(form, 'decision') === 'approve';
  const reason = field(form, 'reason');
  if (!approve && reason.length < 3) return back(to, 'REJECTION_REASON_REQUIRED');
  const decided = await decideLicenceInstall({
    proposalId: id,
    approve,
    decidedBy: admin?.principalId ?? '',
    ...(approve ? {} : { reason }),
  });
  if (!decided.ok) return back(to, `REFUSED:${decided.error.refusal.reason}`);
  back(to, approve ? 'INSTALLED' : 'REJECTED');
}
