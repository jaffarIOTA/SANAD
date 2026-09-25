/**
 * Document checklists — what a programme requires, and whether it is present,
 * missing or expired.
 *
 * BRD §15 and §9: mandatory/optional per product, expiry tracking, checklist
 * management. Per programme and per tenant, as configuration, because two
 * institutions will require different papers for the same structure. Status
 * is a pure function of the checklist, the evidence set and an observed
 * instant — so it is replayable and cannot drift with a server clock.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';

export interface ChecklistItem {
  readonly documentType: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly required: boolean;
  /** Seconds from capture after which the document must be re-obtained. Absent = never. */
  readonly validForSeconds?: number;
}

export interface DocumentChecklist {
  readonly tenantId: string;
  readonly programmeId: string;
  readonly version: string;
  readonly items: readonly ChecklistItem[];
}

/** The slice of an evidence record a checklist needs. */
export interface PresentedDocument {
  readonly documentType: string;
  readonly capturedAt: TsaInstant;
  readonly validationStatus: 'VALID' | 'INVALID' | 'PENDING';
  readonly superseded?: boolean;
}

export type ItemStatus = 'PRESENT' | 'MISSING' | 'EXPIRED' | 'INVALID' | 'PENDING';

export interface ItemReport { readonly item: ChecklistItem; readonly status: ItemStatus; readonly expiresAt?: TsaInstant }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseDocumentChecklist(input: unknown): Result<DocumentChecklist> {
  if (!isRecord(input)) return reject('OP-DETERMINACY', 'CHECKLIST_NOT_AN_OBJECT', 'A checklist must be an object');
  for (const k of Object.keys(input)) {
    if (!['tenantId', 'programmeId', 'version', 'items'].includes(k)) {
      return reject('OP-DETERMINACY', 'CHECKLIST_UNKNOWN_SECTION', `Unknown section '${k}' in document checklist`, { key: k });
    }
  }
  if (typeof input['tenantId'] !== 'string' || typeof input['programmeId'] !== 'string' || typeof input['version'] !== 'string') {
    return reject('OP-DETERMINACY', 'CHECKLIST_IDENTITY_MISSING', 'tenantId, programmeId and version are required');
  }
  if (!Array.isArray(input['items'])) return reject('OP-DETERMINACY', 'CHECKLIST_ITEMS_MISSING', 'items must be a list');
  const items: ChecklistItem[] = [];
  const seen = new Set<string>();
  for (const [i, it] of input['items'].entries()) {
    const where = `items[${String(i)}]`;
    if (!isRecord(it) || typeof it['documentType'] !== 'string' || typeof it['titleEn'] !== 'string' || typeof it['titleAr'] !== 'string' || typeof it['required'] !== 'boolean') {
      return reject('OP-DETERMINACY', 'CHECKLIST_ITEM_INVALID', `${where} needs documentType, titleEn, titleAr and required`, { where });
    }
    if (seen.has(it['documentType'])) return reject('OP-DETERMINACY', 'CHECKLIST_ITEM_DUPLICATE', `${where} repeats a document type`, { where });
    seen.add(it['documentType']);
    if (it['validForSeconds'] !== undefined && (typeof it['validForSeconds'] !== 'number' || !Number.isInteger(it['validForSeconds']) || it['validForSeconds'] <= 0)) {
      return reject('OP-DETERMINACY', 'CHECKLIST_VALIDITY_INVALID', `${where}.validForSeconds must be a positive integer`, { where });
    }
    items.push({ documentType: it['documentType'], titleEn: it['titleEn'], titleAr: it['titleAr'], required: it['required'], ...(it['validForSeconds'] === undefined ? {} : { validForSeconds: it['validForSeconds'] as number }) });
  }
  return ok({ tenantId: input['tenantId'], programmeId: input['programmeId'], version: input['version'], items });
}

/** Per-item status against the evidence, at an observed instant. Pure. */
export function checklistReport(
  checklist: DocumentChecklist,
  presented: readonly PresentedDocument[],
  observedAt: TsaInstant,
): readonly ItemReport[] {
  return checklist.items.map((item) => {
    // The most recent, non-superseded document of the type.
    const candidates = presented.filter((d) => d.documentType === item.documentType && d.superseded !== true).sort((a, b) => Number(b.capturedAt.epochSeconds - a.capturedAt.epochSeconds));
    const doc = candidates[0];
    if (doc === undefined) return { item, status: 'MISSING' };
    if (doc.validationStatus === 'INVALID') return { item, status: 'INVALID' };
    if (doc.validationStatus === 'PENDING') return { item, status: 'PENDING' };
    if (item.validForSeconds !== undefined) {
      const expiresAtSeconds = doc.capturedAt.epochSeconds + BigInt(item.validForSeconds);
      const expiresAt = { ...doc.capturedAt, epochSeconds: expiresAtSeconds } as TsaInstant;
      if (observedAt.epochSeconds >= expiresAtSeconds) return { item, status: 'EXPIRED', expiresAt };
      return { item, status: 'PRESENT', expiresAt };
    }
    return { item, status: 'PRESENT' };
  });
}

/** Complete means every *required* item is PRESENT. Optional items never block. */
export function isChecklistComplete(report: readonly ItemReport[]): boolean {
  return report.every((r) => !r.item.required || r.status === 'PRESENT');
}

export const blockingItems = (report: readonly ItemReport[]): readonly ItemReport[] =>
  report.filter((r) => r.item.required && r.status !== 'PRESENT');
