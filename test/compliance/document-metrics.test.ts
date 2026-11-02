/**
 * Document intelligence D5 through the real path: the throughput view follows
 * what was uploaded, read and decided. Each case attempts something the view
 * must never do, and passes only when it does not:
 *
 *   - decide: measuring records nothing, queues nothing and changes no
 *     document's status;
 *   - mix institutions: one tenant's documents never appear in another's figures;
 *   - flatter: a document the checker accepted although a check failed is
 *     counted as an override, by check — not as agreement.
 *
 * In memory, the demonstration reader (FIXTURE).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  getApplication,
  listApplications,
  queuedBusinessNotifications,
  resetBusinessStore,
  validateDocument,
} from '../../apps/ops/src/server/business.ts';
import { uploadBusinessDocument } from '../../apps/ops/src/server/business-storage.ts';
import { businessDocumentMetrics } from '../../apps/ops/src/server/document-metrics.ts';
import { resetFindings } from '../../services/origination/src/documents/findings.ts';

const T = 'bank-a';
const sample = (lines: string) => new TextEncoder().encode(`%PDF-1.7\n${lines}\n%%EOF`);

let id = '';
beforeEach(async () => {
  resetBusinessStore();
  resetFindings();
  id =
    (await listApplications(T)).find((v) => v.application.status === 'RECEIVED' || v.application.status === 'SPREADING')
      ?.application.applicationId ?? '';
  expect(id).not.toBe('');
});

const upload = async (type: string, bytes: Uint8Array) => {
  const v = expectOk(await uploadBusinessDocument(T, id, type, bytes, 'stf-maker-01', 'c'));
  return v.documents.at(-1)?.documentRef ?? '';
};

describe('the throughput view', () => {
  it('counts a right naming, a failed check, and the checker accepting despite it', async () => {
    const before = await businessDocumentMetrics(T);
    const report = await upload(
      'SIMAH_COMMERCIAL_REPORT',
      sample('SIMAH Commercial Credit Report\nReport Date: 2020-01-01'),
    );
    expectOk(await validateDocument(T, id, report, 'VALID', 'stf-checker-01'));

    const after = await businessDocumentMetrics(T);
    expect(after.read).toBe(before.read + 1);
    expect(after.firstAttempt.namedRight).toBe(before.firstAttempt.namedRight + 1);
    expect(after.checks['ISSUED_WITHIN']?.fail).toBe((before.checks['ISSUED_WITHIN']?.fail ?? 0) + 1);
    expect(after.checker.acceptedDespiteFailure).toBe(before.checker.acceptedDespiteFailure + 1);
    expect(after.checker.acceptedDespiteFailureByCheck['ISSUED_WITHIN']).toBe(
      (before.checker.acceptedDespiteFailureByCheck['ISSUED_WITHIN'] ?? 0) + 1,
    );
    expect(after.checker.agreed).toBe(before.checker.agreed);
  });

  it('measuring records nothing, queues nothing and changes no document', async () => {
    await upload('SIMAH_COMMERCIAL_REPORT', sample('SIMAH Commercial Credit Report\nReport Date: 2020-01-01'));
    const events = (await getApplication(T, id))?.events.length;
    const docs = JSON.stringify((await getApplication(T, id))?.documents.map((d) => d.validationStatus));
    const queued = queuedBusinessNotifications().length;
    await businessDocumentMetrics(T);
    await businessDocumentMetrics(T);
    expect((await getApplication(T, id))?.events.length).toBe(events);
    expect(JSON.stringify((await getApplication(T, id))?.documents.map((d) => d.validationStatus))).toBe(docs);
    expect(queuedBusinessNotifications().length).toBe(queued);
  });

  it('one institution’s documents never appear in another’s figures', async () => {
    const other = await businessDocumentMetrics('fintech-b');
    await upload('SIMAH_COMMERCIAL_REPORT', sample('SIMAH Commercial Credit Report\nReport Date: 2020-01-01'));
    expect(await businessDocumentMetrics('fintech-b')).toEqual(other);
  });
});
