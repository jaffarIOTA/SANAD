/**
 * SR-041: the hosted project's exposed schemas are checked on a schedule, and
 * the check fails on anything but exactly `public` and `graphql_public`.
 * The rule against stand-in API answers; the workflow by reading it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { exposedSchemas, parseSchemas, verdict } from '../../scripts/exposed-schemas-check.mjs';

const REF = 'abcdefghijklmnopqrst';
const answering = (status: number, body: unknown) => (url: string, init: { headers: Record<string, string> }) => {
  expect(url).toBe(`https://api.supabase.com/v1/projects/${REF}/postgrest`);
  expect(init.headers['authorization']).toBe('Bearer test-only-token');
  return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
};

describe('the hosted exposed-schema check (SR-041)', () => {
  it('passes exactly public and graphql_public, in any order or spacing', async () => {
    const schemas = await exposedSchemas({
      ref: REF,
      token: 'test-only-token',
      fetchImpl: answering(200, { db_schema: 'public,  graphql_public' }),
    });
    expect(verdict(schemas)).toEqual([]);
  });

  it('fails a domain schema exposed, and a default removed', () => {
    expect(verdict(parseSchemas('public, graphql_public, core'))).toEqual([
      'schema "core" is exposed through PostgREST; only graphql_public and public may be',
    ]);
    expect(verdict(parseSchemas('public'))).toHaveLength(1);
    expect(verdict(parseSchemas(''))).toHaveLength(2);
  });

  it('refuses to run without its configuration, and echoes no response body', async () => {
    await expect(exposedSchemas({ ref: undefined, token: 'x' })).rejects.toThrow(/SUPABASE_PROJECT_REF/);
    await expect(exposedSchemas({ ref: REF, token: '' })).rejects.toThrow(/SUPABASE_ACCESS_TOKEN/);
    await expect(
      exposedSchemas({ ref: REF, token: 'test-only-token', fetchImpl: answering(401, { message: 'secret detail' }) }),
    ).rejects.toThrow(/^the management API answered 401$/);
  });

  it('runs daily, read-only, with the token from secrets', () => {
    const wf = parse(
      readFileSync(fileURLToPath(new URL('../../.github/workflows/hosted-checks.yml', import.meta.url)), 'utf8'),
    ) as Record<string, any>;
    expect(wf['on']['schedule']).toHaveLength(1);
    expect(wf['permissions']).toEqual({ contents: 'read' });
    const step = (wf['jobs']['exposed-schemas']['steps'] as Record<string, any>[]).find((s) =>
      String(s['run'] ?? '').includes('exposed-schemas-check.mjs'),
    );
    expect(step?.['env']['SUPABASE_ACCESS_TOKEN']).toBe('${{ secrets.SUPABASE_ACCESS_TOKEN }}');
  });
});
