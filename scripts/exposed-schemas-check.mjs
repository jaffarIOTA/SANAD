#!/usr/bin/env node
/**
 * The hosted project exposes no domain schema (SR-041).
 *
 * PostgREST serves exactly the schemas in the project's API settings. Locally
 * that is `supabase/config.toml`, which the tests read; the hosted project's
 * setting lives at Supabase and can be changed in its dashboard, so this asks
 * the management API for it and fails unless it is exactly `public` and
 * `graphql_public`. Run on a schedule by `.github/workflows/hosted-checks.yml`.
 *
 * Environment: SUPABASE_PROJECT_REF (a repository variable) and
 * SUPABASE_ACCESS_TOKEN (a repository secret, a read-capable personal access
 * token). The token is sent in a header and never printed.
 *
 * `verdict()` is the rule, exported for its test.
 */

import { fileURLToPath } from 'node:url';

export const EXPECTED = ['graphql_public', 'public'];

/** The schemas PostgREST exposes, from the API's comma-separated `db_schema`. */
export const parseSchemas = (dbSchema) =>
  String(dbSchema ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort();

/** Violations; none when the exposed schemas are exactly the expected ones. */
export function verdict(schemas) {
  const extra = schemas.filter((s) => !EXPECTED.includes(s));
  const missing = EXPECTED.filter((s) => !schemas.includes(s));
  return [
    ...extra.map((s) => `schema "${s}" is exposed through PostgREST; only ${EXPECTED.join(' and ')} may be`),
    ...missing.map((s) => `schema "${s}" is not exposed; the setting is not the one the platform expects`),
  ];
}

export async function exposedSchemas({ ref, token, fetchImpl = fetch }) {
  if (!/^[a-z0-9]{20}$/.test(ref ?? '')) throw new Error('SUPABASE_PROJECT_REF is not set to a project reference');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set');
  const r = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}/postgrest`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  // The status only: a response body is not echoed.
  if (!r.ok) throw new Error(`the management API answered ${String(r.status)}`);
  const body = await r.json();
  return parseSchemas(body?.db_schema);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const schemas = await exposedSchemas({
      ref: process.env.SUPABASE_PROJECT_REF,
      token: process.env.SUPABASE_ACCESS_TOKEN,
    });
    const violations = verdict(schemas);
    if (violations.length > 0) {
      process.stderr.write(`Exposed-schema check failed:\n${violations.map((v) => `  ${v}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write(`Exposed-schema check passed: ${schemas.join(', ')}\n`);
  } catch (error) {
    process.stderr.write(`Exposed-schema check could not run: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  }
}
