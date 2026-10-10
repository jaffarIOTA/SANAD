/**
 * SR-020: the ops document route serves bytes only to staff of the document's
 * institution, and only the bytes that were recorded.
 *
 * No session is 401; another institution's staff get 404, as for an unknown
 * document; bytes that are not the ones the hash names are refused (409).
 * The samples are generated (deterministically) into a scratch directory, so
 * the test never touches the repository's own copies.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => {
  process.env['OPS_SESSION_SECRET'] = 'f6'.repeat(32);
  return new Map<string, string>();
});
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
}));

import { GET } from '../../apps/ops/src/app/api/documents/v1/artefacts/[documentId]/route.ts';
import { STAFF_SESSION_COOKIE, epochNow, issueStaffSession } from '../../apps/ops/src/server/staff-session.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ID = 'sample-delivery-note';
let scratch: string;
let sample: string;
let original: Buffer;

const signIn = (tenantId: 'bank-a' | 'sme-fund-ae') => {
  jar.set(
    STAFF_SESSION_COOKIE,
    issueStaffSession({ principalId: `stf-${tenantId}`, tenantId, authorities: ['MAKER'] }, 600n, epochNow()).token,
  );
};
const get = (id = ID) =>
  GET(new Request(`https://ops.sanad.test/api/documents/v1/artefacts/${id}`), {
    params: Promise.resolve({ documentId: id }),
  });

describe('document artefacts (SR-020)', () => {
  beforeAll(() => {
    execFileSync('node', [join(ROOT, 'scripts/nutrient-samples.mjs')]);
    scratch = mkdtempSync(join(tmpdir(), 'sanad-samples-'));
    cpSync(join(ROOT, 'adapters/nutrient/verification/samples'), scratch, { recursive: true });
    vi.stubEnv('SANAD_DOCUMENT_SAMPLES_DIR', scratch);
    sample = join(scratch, 'synthetic-delivery-note.pdf');
    original = readFileSync(sample);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
    jar.clear();
  });

  it('answers 401 with no staff session', async () => {
    jar.clear();
    expect((await get()).status).toBe(401);
  });

  it("answers 404 to another institution's staff, as for an unknown document", async () => {
    signIn('sme-fund-ae');
    expect((await get()).status).toBe(404);
    expect((await get('no-such-document')).status).toBe(404);
  });

  it('serves the recorded bytes to staff of the institution', async () => {
    signIn('bank-a');
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await r.arrayBuffer()).equals(original)).toBe(true);
  });

  it('refuses bytes that are not the ones recorded', async () => {
    signIn('bank-a');
    writeFileSync(sample, Buffer.concat([original, Buffer.from('%tampered')]));
    expect((await get()).status).toBe(409);
    writeFileSync(sample, original);
    expect((await get()).status).toBe(200);
  });
});
