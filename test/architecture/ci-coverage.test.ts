/**
 * SR-024: every suite runs in CI, with and without a database.
 *
 * Database-backed tests skip without SANAD_TEST_DATABASE_URL and a few
 * in-memory variants skip with it, so one run cannot cover everything. Two
 * runs of the whole suite do, and an item in the security register closes only
 * on a test that runs in CI. This keeps both runs in `security.yml`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Step {
  readonly name?: string;
  readonly run?: string;
}
interface Job {
  readonly steps: readonly Step[];
  readonly env?: Record<string, string>;
  readonly services?: Record<string, { readonly image: string }>;
}

const workflow = parse(
  readFileSync(fileURLToPath(new URL('../../.github/workflows/security.yml', import.meta.url)), 'utf8'),
) as { readonly jobs: Record<string, Job> };

const runsWholeSuite = (job: Job): boolean => job.steps.some((s) => s.run?.trim() === 'npx vitest run');

describe('CI runs the whole suite both ways (SR-024)', () => {
  it('runs every suite in a job with no database', () => {
    const job = workflow.jobs['compliance-gates'];
    expect(job).toBeDefined();
    expect(runsWholeSuite(job as Job)).toBe(true);
    expect((job as Job).env?.['SANAD_TEST_DATABASE_URL']).toBeUndefined();
  });

  it('runs every suite against PostgreSQL with every migration applied', () => {
    const job = workflow.jobs['database-controls'];
    expect(job).toBeDefined();
    const j = job as Job;
    expect(runsWholeSuite(j)).toBe(true);
    expect(j.env?.['SANAD_TEST_DATABASE_URL']).toMatch(/^postgresql:\/\//);
    expect(Object.values(j.services ?? {}).some((s) => /postgres/.test(s.image))).toBe(true);
    expect(j.steps.some((s) => /supabase\/migrations\/\*\.sql/.test(s.run ?? ''))).toBe(true);
  });
});
