/**
 * Uploaded documents for a business application (UAE M2b): the bytes go to
 * the tenant's object store, the application records the hash.
 *
 * Which store: the tenant's configured S3-compatible store when its
 * credentials are in the vault (capability OBJECT_STORAGE); otherwise, only
 * where a synthetic demonstration is permitted, the in-memory fixture store,
 * labelled Fixture on screen; otherwise none, and an upload is refused as
 * unavailable. A store that is down or refuses stores nothing and presents
 * nothing (CLAUDE.md §5).
 *
 * An object's key is the tenant, the application and the hash of the bytes:
 * no file name, no party. The same file uploaded twice is the same object.
 * Bytes are stored before the document is presented; if presenting is then
 * refused, the object is left unreferenced (content-addressed, so harmless)
 * and nothing points at it.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { acceptUpload } from '@sanad/core/documents/upload.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { ObjectStoragePort, StorableMediaType } from '@sanad/core/ports/object-storage.ts';
import { credentialProviderFromEnvironment } from '@sanad/origination/credentials.ts';
import { readPresentedDocument } from '@sanad/origination/documents/findings.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import { InMemoryObjectStorage } from '../../../../adapters/storage/memory.ts';
import { S3ObjectStorage } from '../../../../adapters/storage/s3/adapter.ts';
import { type BusinessApplicationView, checklistStatus, getApplication, presentDocument } from './business.ts';
import { resumeIfComplete } from './business-gaps.ts';
import { documentAuthenticity } from './business-rails.ts';
import { persistencePool } from './persistence.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** One fixture store per process, kept across module reloads in development. */
const FIXTURE_KEY = Symbol.for('sanad.ops.fixtureObjectStorage');
const fixtureStore = (): InMemoryObjectStorage => {
  const g = globalThis as { [FIXTURE_KEY]?: InMemoryObjectStorage };
  g[FIXTURE_KEY] ??= new InMemoryObjectStorage();
  return g[FIXTURE_KEY];
};

/** The tenant's object store, or undefined where none may be used. */
export async function objectStorageFor(
  tenant: TenantCode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ObjectStoragePort | undefined> {
  const vault = credentialProviderFromEnvironment(env);
  try {
    await vault.get(
      { tenantId: tenant, provider: 'OBJECT_STORAGE', environment: 'sandbox', keyName: 'bucket' },
      'object-storage-selection',
    );
    return new S3ObjectStorage(vault, { environment: 'sandbox', nowEpochSeconds: nowSeconds });
  } catch {
    // Not configured for this tenant: the fixture store, only where a synthetic demonstration is permitted.
  }
  if (await syntheticDemonstrationPermitted(persistencePool(env), env)) return fixtureStore();
  return undefined;
}

export const objectKeyFor = (tenant: TenantCode, applicationId: string, sha256Hex: string): string =>
  `${tenant}/business/${applicationId}/${sha256Hex}`;

/** The document reference an upload is presented under: the store's key, without the tenant. */
const documentRefFor = (applicationId: string, sha256Hex: string): string => `obj:${applicationId}/${sha256Hex}`;

/**
 * Store the bytes, then present the document against the application, PENDING
 * until a different person validates it — exactly as a referenced document.
 */
export async function uploadBusinessDocument(
  tenant: TenantCode,
  applicationId: string,
  documentType: string,
  bytes: Uint8Array,
  actor: string,
  correlationId: string,
): Promise<Result<BusinessApplicationView>> {
  if ((await getApplication(tenant, applicationId)) === undefined)
    return fail('BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  const accepted = acceptUpload(bytes);
  if (!accepted.ok) return accepted;
  const store = await objectStorageFor(tenant);
  if (store === undefined)
    return fail('STORAGE_UNAVAILABLE', 'No document store is configured here; nothing was stored');
  const { sha256Hex, mediaType, byteLength } = accepted.value;
  const put = await store.put({
    tenantId: tenant,
    objectKey: objectKeyFor(tenant, applicationId, sha256Hex),
    bytes,
    mediaType,
    sha256Hex,
    correlationId,
  });
  if (!put.ok) return put;
  if (put.value.kind !== 'ANSWERED')
    return fail('STORAGE_UNAVAILABLE', 'The document store did not take the file; nothing was presented', {
      outcome: put.value.kind,
    });
  const documentRef = documentRefFor(applicationId, sha256Hex);
  const presented = await presentDocument(
    tenant,
    applicationId,
    { documentType, documentRef, content: { sha256Hex, byteLength, mediaType, storage: store.source } },
    actor,
  );
  if (!presented.ok) return presented;
  // Document intelligence (D1, D2): read what was presented, and hold it to the checklist item's declared checks, for
  // the checker. Never a gate: an engine that is absent, down or cannot read the file leaves the document unread and
  // checked by a person, exactly as before; a failed check is shown to the checker, who decides.
  const checklist = await checklistStatus(tenant, applicationId);
  const rules = checklist.ok
    ? checklist.value.checklist.items.find((i) => i.documentType === documentType)?.checks
    : undefined;
  const applicant = presented.value.application.applicant;
  // D3: where the item declares an AUTHENTIC check, ask the issuer, under the business's consent. Its answer is a
  // finding like the rest: a document the issuer does not confirm is accepted only with the checker's resolution.
  const authenticity = rules?.some((r) => r.check === 'AUTHENTIC')
    ? await documentAuthenticity(tenant, presented.value.application, { documentType, documentRef })
    : undefined;
  await readPresentedDocument(
    tenant,
    { kind: 'BUSINESS_APPLICATION', ref: applicationId },
    { documentRef, declaredType: documentType, sha256Hex, mediaType, bytes },
    {
      ...(rules === undefined ? {} : { rules }),
      ...(authenticity === undefined ? {} : { authenticity }),
      expect: {
        registrationNumber: applicant.registrationRef,
        names: [
          applicant.businessNameEn,
          ...(applicant.businessNameAr === undefined ? [] : [applicant.businessNameAr]),
        ],
      },
    },
  );
  // D4: the document that closes the last gap of an open request records the documents received.
  await resumeIfComplete(tenant, applicationId, actor);
  return ok((await getApplication(tenant, applicationId)) ?? presented.value);
}

/**
 * The bytes of a document the application holds, for a signed-in member of
 * the tenant's staff. A hash the application does not hold is NOT_HELD —
 * as if it did not exist — so a guessed hash reads nothing.
 */
export async function readBusinessDocument(
  tenant: TenantCode,
  applicationId: string,
  sha256Hex: string,
  correlationId: string,
): Promise<
  | { readonly kind: 'BYTES'; readonly bytes: Uint8Array; readonly mediaType: StorableMediaType }
  | { readonly kind: 'NOT_HELD' | 'UNAVAILABLE' | 'TAMPERED' }
> {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) return { kind: 'NOT_HELD' };
  const view = await getApplication(tenant, applicationId);
  const held = view?.documents.find((d) => d.content?.sha256Hex === sha256Hex);
  if (held === undefined) return { kind: 'NOT_HELD' };
  const store = await objectStorageFor(tenant);
  if (store === undefined) return { kind: 'UNAVAILABLE' };
  const got = await store.get({
    tenantId: tenant,
    objectKey: objectKeyFor(tenant, applicationId, sha256Hex),
    sha256Hex,
    correlationId,
  });
  if (!got.ok) return { kind: got.error.reason === 'OBJECT_TAMPERED' ? 'TAMPERED' : 'UNAVAILABLE' };
  if (got.value.kind !== 'ANSWERED') return { kind: 'UNAVAILABLE' };
  return { kind: 'BYTES', ...got.value.value };
}
