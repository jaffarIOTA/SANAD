/**
 * Document intelligence D4 through the real path: an officer asks the
 * applicant for what the application still needs, and the case comes back to
 * the officer's queue when the last document arrives. Each case attempts
 * something the request must never do, and passes only when it does not:
 *
 *   - send twice: asking again for the same open set queues nothing more;
 *   - leak: the notification carries document codes, never the business's
 *     name, its registration number or anything read from a document;
 *   - resume early: the request stays open while any gap is left, including a
 *     document that arrived but fails a check;
 *   - decide: closing the last gap by the checker's acceptance is the
 *     checker's act; a request accepts and refuses nothing.
 *
 * In memory (bank-a), the demonstration reader (FIXTURE).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  getApplication,
  listApplications,
  queuedBusinessNotifications,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';
import { statusChip } from '../../apps/ops/src/server/business-dashboard.ts';
import {
  documentGaps,
  requestMissingDocuments,
  validateDocumentAndResume,
} from '../../apps/ops/src/server/business-gaps.ts';
import { uploadBusinessDocument } from '../../apps/ops/src/server/business-storage.ts';
import { resetFindings } from '../../services/origination/src/documents/findings.ts';

const T = 'bank-a';
const OFFICER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const sample = (lines: string) => new TextEncoder().encode(`%PDF-1.7\n${lines}\n%%EOF`);
/** A page the reader recognises as nothing: its checks cannot be made, so it closes a MISSING gap. */
const PLAIN = sample('A synthetic page');

let id = '';
let name = '';
let cr = '';
beforeEach(async () => {
  resetBusinessStore();
  resetFindings();
  const v = (await listApplications(T)).find(
    (x) => (x.application.status === 'RECEIVED' || x.application.status === 'SPREADING') && x.contact.emailMasked,
  );
  id = v?.application.applicationId ?? '';
  name = v?.application.applicant.businessNameEn ?? '';
  cr = v?.application.applicant.registrationRef ?? '';
  expect(id).not.toBe('');
});

const gaps = async () => expectOk(await documentGaps(T, id));
const requests = () =>
  queuedBusinessNotifications().filter((e) => e.subjectRef === id && e.payload['event'] === 'INFORMATION_REQUESTED');
const chip = async () => {
  const v = await getApplication(T, id);
  return v === undefined ? undefined : statusChip(v, 0n).code;
};
const closeAllBut = async (keep: string) => {
  for (const g of await gaps())
    if (g.documentType !== keep) expectOk(await uploadBusinessDocument(T, id, g.documentType, PLAIN, OFFICER, 'c'));
};

/** Each case uploads most of a checklist, each upload read and checked: slower than one call, against a database most of all. */
const MANY_UPLOADS = { timeout: 30_000 };

describe('asking for what is missing', MANY_UPLOADS, () => {
  it('queues one notification of document codes to the applicant’s contact, and the queue shows it waiting', async () => {
    const before = await gaps();
    expect(before.length).toBeGreaterThan(0);
    const view = expectOk(await requestMissingDocuments(T, id, OFFICER));
    expect(view.documentRequest).toMatchObject({ status: 'AWAITING', count: before.length });
    expect(view.events.at(-1)).toMatchObject({ eventType: 'DOCUMENTS_REQUESTED', actor: OFFICER });

    const [n] = requests();
    expect(requests()).toHaveLength(1);
    expect(n?.payload).toMatchObject({
      recipientKind: 'COUNTERPARTY',
      recipientRef: view.contact.partyRef,
      count: String(before.length),
    });
    expect(n?.payload['documents']).toContain(`${before[0]?.documentType ?? ''}:${before[0]?.kind ?? ''}`);
    const sent = JSON.stringify(n?.payload);
    expect(sent).not.toContain(name);
    expect(sent).not.toContain(cr);
    expect(await chip()).toBe('AWAITING_DOCUMENTS');
  });

  it('asking again for the same open set sends nothing more; a different set is a new request', async () => {
    expectOk(await requestMissingDocuments(T, id, OFFICER));
    expectOk(await requestMissingDocuments(T, id, OFFICER));
    expect(requests()).toHaveLength(1);
    const [first] = await gaps();
    expectOk(await uploadBusinessDocument(T, id, first?.documentType ?? '', PLAIN, OFFICER, 'c'));
    expectOk(await requestMissingDocuments(T, id, OFFICER));
    expect(requests()).toHaveLength(2);
    expect(new Set(requests().map((e) => e.idempotencyKey)).size).toBe(2);
  });

  it('nothing to ask for is refused, not sent', async () => {
    await closeAllBut('');
    const r = await requestMissingDocuments(T, id, OFFICER);
    expect(r.ok ? 'sent' : r.error.reason).toBe('NO_DOCUMENT_GAPS');
    expect(requests()).toHaveLength(0);
  });
});

describe('resuming when the documents arrive', MANY_UPLOADS, () => {
  it('the document that closes the last gap records them received, and the queue shows the case ready', async () => {
    expectOk(await requestMissingDocuments(T, id, OFFICER));
    const keep = (await gaps())[0]?.documentType ?? '';
    await closeAllBut(keep);
    expect((await getApplication(T, id))?.documentRequest?.status).toBe('AWAITING');
    const last = expectOk(await uploadBusinessDocument(T, id, keep, PLAIN, OFFICER, 'c'));
    expect(last.events.at(-1)).toMatchObject({ eventType: 'DOCUMENTS_RECEIVED', actor: OFFICER });
    expect(await chip()).toBe('DOCUMENTS_RECEIVED');
  });

  it('a document that arrives but fails a check keeps the request open, until the checker accepts it', async () => {
    const STATEMENT = 'COMPANY_BANK_STATEMENT_12M';
    expect((await gaps()).map((g) => g.documentType)).toContain(STATEMENT);
    expectOk(await requestMissingDocuments(T, id, OFFICER));
    await closeAllBut(STATEMENT);
    // Two months, long ago: a statement, but not the year the checklist asks for.
    const short = sample(
      'Example Bank - Account Statement\nStatement Period: 01/01/2020 - 29/02/2020\nClosing Balance',
    );
    expectOk(await uploadBusinessDocument(T, id, STATEMENT, short, OFFICER, 'c'));
    expect(await gaps()).toEqual([
      expect.objectContaining({
        documentType: STATEMENT,
        kind: 'CHECK_FAILED',
        failedChecks: ['PERIOD_COVERS', 'PERIOD_ENDS_WITHIN'],
      }),
    ]);
    expect((await getApplication(T, id))?.documentRequest?.status).toBe('AWAITING');

    // The checker accepts it anyway — their call — and that closes the last gap.
    const doc = (await getApplication(T, id))?.documents.at(-1);
    const own = await validateDocumentAndResume(T, id, doc?.documentRef ?? '', 'VALID', OFFICER);
    expect(own.ok ? 'accepted' : own.error.reason).toBe('FOUR_EYES_REQUIRED');
    const accepted = expectOk(await validateDocumentAndResume(T, id, doc?.documentRef ?? '', 'VALID', CHECKER));
    expect(accepted.documentRequest?.status).toBe('RECEIVED');
  });

  it('the case stops showing "received" once anything else happens on it', async () => {
    expectOk(await requestMissingDocuments(T, id, OFFICER));
    await closeAllBut('');
    expect(await chip()).toBe('DOCUMENTS_RECEIVED');
    const doc = (await getApplication(T, id))?.documents.at(-1);
    expectOk(await validateDocumentAndResume(T, id, doc?.documentRef ?? '', 'VALID', CHECKER));
    expect((await getApplication(T, id))?.documentRequest).toBeUndefined();
    expect(await chip()).not.toBe('DOCUMENTS_RECEIVED');
  });
});
