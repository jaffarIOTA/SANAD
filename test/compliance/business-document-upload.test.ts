/**
 * Uploading a business application's documents (UAE M2b). Each case attempts
 * something the journey forbids — a file that is not what it claims, an
 * uploader validating their own file, another institution or a guessed hash
 * reading a document — and passes only when it is refused.
 *
 * The book is the service's in-memory seed; with no store in the vault the
 * upload goes to the labelled fixture store, as on the synthetic site.
 */
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES, acceptUpload, sniffMediaType } from '@sanad/core/documents/upload.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  getApplication,
  listApplications,
  resetBusinessStore,
  validateDocument,
} from '../../apps/ops/src/server/business.ts';
import { readBusinessDocument, uploadBusinessDocument } from '../../apps/ops/src/server/business-storage.ts';

const pdf = new TextEncoder().encode('%PDF-1.7\nsynthetic trade licence\n%%EOF');
const sha = createHash('sha256').update(pdf).digest('hex');
let open = '';

beforeEach(async () => {
  resetBusinessStore();
  const views = await listApplications('sme-fund-ae');
  open = views.find((v) => v.application.status === 'RECEIVED' || v.application.status === 'SPREADING')?.application
    .applicationId ?? '';
  expect(open).not.toBe('');
});

describe('what counts as an acceptable file', () => {
  it('reads the type from the bytes, not the name', () => {
    expect(sniffMediaType(pdf)).toBe('application/pdf');
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMediaType(new TextEncoder().encode('<html><script>'))).toBeUndefined();
  });
  it('refuses an empty file, an oversized one and anything else', () => {
    const reason = (b: Uint8Array) => {
      const r = acceptUpload(b);
      return r.ok ? 'accepted' : r.error.reason;
    };
    expect(reason(new Uint8Array())).toBe('UPLOAD_EMPTY');
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(pdf);
    expect(reason(big)).toBe('UPLOAD_TOO_LARGE');
    expect(reason(new TextEncoder().encode('MZ executable'))).toBe('UPLOAD_TYPE_NOT_ACCEPTED');
  });
});

describe('uploading against an application', () => {
  it('stores the bytes and presents the document PENDING, recorded by hash and labelled Fixture', async () => {
    const v = expectOk(await uploadBusinessDocument('sme-fund-ae', open, 'TRADE_LICENCE', pdf, 'officer-1', 'c'));
    const doc = v.documents.at(-1);
    expect(doc).toMatchObject({
      documentType: 'TRADE_LICENCE',
      documentRef: `obj:${open}/${sha}`,
      validationStatus: 'PENDING',
      presentedBy: 'officer-1',
      content: { sha256Hex: sha, byteLength: pdf.byteLength, mediaType: 'application/pdf', storage: 'FIXTURE' },
    });
  });

  it('refuses a file that is not a PDF or image and presents nothing', async () => {
    const before = (await getApplication('sme-fund-ae', open))?.documents.length;
    const r = await uploadBusinessDocument('sme-fund-ae', open, 'TRADE_LICENCE', new TextEncoder().encode('<svg onload=x>'), 'officer-1', 'c');
    expect(r.ok ? 'presented' : r.error.reason).toBe('UPLOAD_TYPE_NOT_ACCEPTED');
    expect((await getApplication('sme-fund-ae', open))?.documents.length).toBe(before);
  });

  it('the uploader cannot validate their own file; another person can', async () => {
    expectOk(await uploadBusinessDocument('sme-fund-ae', open, 'TRADE_LICENCE', pdf, 'officer-1', 'c'));
    const ref = `obj:${open}/${sha}`;
    const own = await validateDocument('sme-fund-ae', open, ref, 'VALID', 'officer-1');
    expect(own.ok ? 'validated' : own.error.reason).toBe('FOUR_EYES_REQUIRED');
    const checked = expectOk(await validateDocument('sme-fund-ae', open, ref, 'VALID', 'checker-1'));
    expect(checked.documents.at(-1)?.validationStatus).toBe('VALID');
  });

  it('refuses an application that does not exist', async () => {
    const r = await uploadBusinessDocument('sme-fund-ae', 'FR-99999999', 'TRADE_LICENCE', pdf, 'officer-1', 'c');
    expect(r.ok ? 'presented' : r.error.reason).toBe('BUSINESS_APPLICATION_NOT_FOUND');
  });
});

describe('reading an uploaded document back', () => {
  it('serves the application’s own file, checked against its hash', async () => {
    expectOk(await uploadBusinessDocument('sme-fund-ae', open, 'TRADE_LICENCE', pdf, 'officer-1', 'c'));
    const r = await readBusinessDocument('sme-fund-ae', open, sha, 'c');
    expect(r.kind).toBe('BYTES');
    if (r.kind === 'BYTES') expect(Buffer.from(r.bytes).equals(Buffer.from(pdf))).toBe(true);
  });

  it('reads nothing for a guessed hash, a malformed one, or another institution', async () => {
    expectOk(await uploadBusinessDocument('sme-fund-ae', open, 'TRADE_LICENCE', pdf, 'officer-1', 'c'));
    expect((await readBusinessDocument('sme-fund-ae', open, 'f'.repeat(64), 'c')).kind).toBe('NOT_HELD');
    expect((await readBusinessDocument('sme-fund-ae', open, '../../etc/passwd', 'c')).kind).toBe('NOT_HELD');
    // The KSA tenant has no such application: as if it did not exist.
    expect((await readBusinessDocument('bank-a', open, sha, 'c')).kind).toBe('NOT_HELD');
  });
});
