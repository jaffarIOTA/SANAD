/**
 * Reading presented documents into findings, and keeping them (document
 * intelligence D1, docs/DOCUMENT-INTELLIGENCE-PLAN.md). Shared by every
 * journey: a journey presents a document as it always has, then asks for it
 * to be read; the findings are an aid for the checker, never a gate.
 *
 * Which engine (`documentUnderstandingFor`):
 *   - the tenant's own document engine, where its endpoint and token are in
 *     the vault (LIVE) — the rules over its text;
 *   - otherwise, only where a synthetic demonstration is permitted, the
 *     demonstration reader (FIXTURE), which reads the synthetic samples only;
 *   - otherwise none: the document is presented unread.
 * An AI engine is a second implementation of the same port, selected per
 * tenant once its hosting is approved (the catalogue's `engine`).
 *
 * Where findings live: `evidence.document_finding` (migration 0029) when a
 * database is configured, append-only and tenant-scoped; this process's
 * memory otherwise.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { type TenantCode, loadDocumentTypeCatalogue } from '@sanad/config/loader.ts';
import type { Authenticity, CheckContext, DocumentCheckRule } from '@sanad/core/documents/document-checks.ts';
import {
  type DocumentFindings,
  type DocumentUnderstandingPort,
  type Expectations,
  findingsOf,
  rulesEngine,
} from '@sanad/core/documents/understanding.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { CredentialProvider } from '@sanad/core/ports/credentials.ts';

import { DemonstrationDocumentExtraction } from '../../../../adapters/documents/demonstration-extraction.ts';
import { NutrientDocumentExtraction } from '../../../../adapters/nutrient/document-extraction.ts';
import { engineEndpoint } from '../../../../adapters/nutrient/engine-endpoint.ts';
import { civilDateOf } from '../civil-date.ts';
import { credentialProviderFromEnvironment, sharedPool, tenantUuidByCode } from '../credentials.ts';
import { gregorianOfUmmAlQura } from '../hijri.ts';
import { hostClockInstant } from '../host-clock.ts';
import { syntheticDemonstrationPermitted } from '../profile.ts';
import { inTenant } from '../tenant-scope.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type FindingSubject = 'BUSINESS_APPLICATION' | 'WASL_REQUEST';

export interface StoredFindings extends DocumentFindings {
  readonly subjectKind: FindingSubject;
  readonly subjectRef: string;
  readonly documentRef: string;
  readonly contentSha256: string;
  readonly recordedAtEpochSeconds: bigint;
}

const poolOf = (env: Env): Pool | undefined => {
  const url = env['SANAD_DATABASE_URL']?.trim();
  return url === undefined || url.length === 0 ? undefined : sharedPool(url);
};

/** The engine that reads this tenant's documents here, or undefined where none may. */
export async function documentUnderstandingFor(
  tenant: TenantCode,
  vault?: CredentialProvider,
  env: Env = process.env,
): Promise<DocumentUnderstandingPort | undefined> {
  const credentials = vault ?? credentialProviderFromEnvironment(env);
  const endpoint = await engineEndpoint(credentials, tenant, 'sandbox', 'document-understanding-selection');
  // The document engine's own adapter reads no clock of its own beyond its circuit breaker's: it is handed the host's.
  const now = () => Number(hostClockInstant().epochSeconds);
  if (endpoint.ok)
    return rulesEngine(new NutrientDocumentExtraction(credentials, { environment: 'sandbox', nowEpochSeconds: now }));
  if (await syntheticDemonstrationPermitted(poolOf(env), env))
    return rulesEngine(new DemonstrationDocumentExtraction());
  return undefined;
}

// -- Keeping findings --------------------------------------------------------------------

const MEMORY = Symbol.for('sanad.documents.findings');
const memory = (): StoredFindings[] => {
  const g = globalThis as { [MEMORY]?: StoredFindings[] };
  g[MEMORY] ??= [];
  return g[MEMORY];
};

/** Tests only: forget every finding held in memory. */
export function resetFindings(): void {
  memory().length = 0;
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

async function keep(f: StoredFindings, tenant: TenantCode, env: Env): Promise<Result<true>> {
  const pool = poolOf(env);
  if (pool === undefined) {
    memory().push(f);
    return ok(true);
  }
  try {
    const tenantUuid = await tenantUuidByCode(pool, tenant);
    await inTenant(pool, tenantUuid, (db) =>
      db.query(
        `insert into evidence.document_finding (tenant_id, subject_kind, subject_ref, document_ref, content_sha256,
           declared_type, classification, facts, checks, engine, catalogue_version, source, correlation_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13)`,
        [
          tenantUuid,
          f.subjectKind,
          f.subjectRef,
          f.documentRef,
          f.contentSha256,
          f.declaredType,
          json(f.classification),
          json(f.facts),
          json(f.checks),
          f.engine,
          f.catalogueVersion,
          f.source,
          randomUUID(),
        ],
      ),
    );
    return ok(true);
  } catch {
    return reject(
      'OP-DETERMINACY',
      'FINDINGS_NOT_KEPT',
      'The findings could not be written; the document stands unread',
    );
  }
}

/**
 * Read one presented document and keep its findings. Never fails the
 * presentation: an engine that is absent, down or unable to read the file
 * yields no findings, and the document is checked by a person as it always was.
 */
export async function readPresentedDocument(
  tenant: TenantCode,
  subject: { readonly kind: FindingSubject; readonly ref: string },
  document: {
    readonly documentRef: string;
    readonly declaredType: string;
    readonly sha256Hex: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  },
  /**
   * D2: the checklist item's declared checks, and what the application
   * expects the document to carry. The expectations are compared during the
   * reading and dropped: only the outcome is kept.
   */
  content: {
    readonly rules?: readonly DocumentCheckRule[];
    readonly expect?: Expectations;
    /** D3: the issuer's answer on this document, asked by the journey under its consent. */
    readonly authenticity?: Authenticity;
  } = {},
  env: Env = process.env,
): Promise<Result<StoredFindings>> {
  const catalogue = loadDocumentTypeCatalogue(tenant);
  if (!catalogue.ok) return catalogue;
  const engine = await documentUnderstandingFor(tenant, credentialProviderFromEnvironment(env), env);
  const read =
    engine === undefined
      ? undefined
      : await engine.understand({
          tenantId: tenant,
          bytes: document.bytes,
          mediaType: document.mediaType,
          catalogue: catalogue.value,
          ...(content.expect === undefined ? {} : { expect: content.expect }),
          correlationId: randomUUID(),
        });
  const understood = read?.ok === true && read.value.kind === 'ANSWERED' ? read.value.value : undefined;
  let meta: { readonly engine: string; readonly source: 'LIVE' | 'FIXTURE' };
  if (engine !== undefined && understood !== undefined) meta = { engine: engine.engine, source: engine.source };
  else {
    // Unread, the document may still carry the issuer's answer (D3): that is kept, with the reading as not read.
    const a = content.authenticity;
    if (a === undefined || a.status === 'NOT_CHECKED')
      return reject('OP-DETERMINACY', 'DOCUMENT_READING_UNAVAILABLE', 'The document was not read here');
    meta = { engine: 'none', source: a.source };
  }
  const at = hostClockInstant();
  // The reading date is the institution's civil date at the instant of reading; a Hijri date converts on Umm al-Qura.
  const context: CheckContext = {
    asOf: civilDateOf(tenant, at),
    toGregorian: (d) => (d.calendar === 'GREGORIAN' ? d.date : gregorianOfUmmAlQura(d.date)),
    ...(content.authenticity === undefined ? {} : { authenticity: content.authenticity }),
  };
  const findings: StoredFindings = {
    ...findingsOf(
      understood ?? { classification: { status: 'UNREADABLE', reason: 'NOT_READ' }, facts: [], pagesRead: 0 },
      document.declaredType,
      catalogue.value,
      meta,
      content.rules === undefined || content.rules.length === 0 ? undefined : { rules: content.rules, context },
    ),
    subjectKind: subject.kind,
    subjectRef: subject.ref,
    documentRef: document.documentRef,
    contentSha256: document.sha256Hex,
    recordedAtEpochSeconds: at.epochSeconds,
  };
  const kept = await keep(findings, tenant, env);
  return kept.ok ? ok(findings) : kept;
}

/** The latest findings for each document on a subject, keyed by the document's hash. */
export async function findingsFor(
  tenant: TenantCode,
  subject: { readonly kind: FindingSubject; readonly ref: string },
  env: Env = process.env,
): Promise<ReadonlyMap<string, StoredFindings>> {
  const latest = new Map<string, StoredFindings>();
  const pool = poolOf(env);
  if (pool === undefined) {
    for (const f of memory())
      if (f.subjectKind === subject.kind && f.subjectRef === subject.ref) latest.set(f.contentSha256, f);
    return latest;
  }
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const { rows } = await inTenant(pool, tenantUuid, (db) =>
    db.query<{
      document_ref: string;
      content_sha256: string;
      declared_type: string;
      classification: StoredFindings['classification'];
      facts: StoredFindings['facts'];
      checks: StoredFindings['checks'];
      engine: string;
      catalogue_version: string;
      source: 'LIVE' | 'FIXTURE';
      at: string;
    }>(
      `select document_ref, content_sha256, declared_type, classification, facts, checks, engine, catalogue_version, source,
              extract(epoch from created_at)::bigint::text at
         from evidence.document_finding
        where tenant_id = $1 and subject_kind = $2 and subject_ref = $3
        order by created_at`,
      [tenantUuid, subject.kind, subject.ref],
    ),
  );
  for (const r of rows)
    latest.set(r.content_sha256, {
      subjectKind: subject.kind,
      subjectRef: subject.ref,
      documentRef: r.document_ref,
      contentSha256: r.content_sha256,
      declaredType: r.declared_type,
      classification: r.classification,
      facts: r.facts,
      checks: r.checks,
      engine: r.engine,
      catalogueVersion: r.catalogue_version,
      source: r.source,
      pagesRead: 0,
      recordedAtEpochSeconds: BigInt(r.at),
    });
  return latest;
}
