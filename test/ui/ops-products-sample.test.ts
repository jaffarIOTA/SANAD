/**
 * #17 The products page quotes its worked samples in the tenant's own
 * currency from its onboarding record. When that record does not load, it
 * refuses to quote and says why — it never falls back to SAR / SA.
 *
 * A source-level assertion: the ops app compiles JSX with `preserve`, which
 * the test transformer cannot execute, so the page cannot be rendered here.
 * The page's sample context is asserted to have no default currency or
 * jurisdiction, and to refuse with a named reason.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PAGE = readFileSync(
  fileURLToPath(new URL('../../apps/ops/src/app/[locale]/products/page.tsx', import.meta.url)),
  'utf8',
);

const functionBody = (name: string): string => {
  const start = PAGE.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = PAGE.indexOf('\n}\n', start);
  return PAGE.slice(start, end);
};

describe('products page samples and the tenant’s onboarding', () => {
  it('has no fallback currency or jurisdiction for the sample', () => {
    const body = functionBody('sampleContextFor');
    expect(body).not.toMatch(/currency:\s*'SAR'/);
    expect(body).not.toMatch(/jurisdiction:\s*'SA'/);
    expect(body).toContain('TENANT_ONBOARDING_UNAVAILABLE');
    expect(body).toMatch(/Result<SampleContext>/);
  });

  it('refuses the quote, with the reason, when the onboarding did not load', () => {
    expect(PAGE).toMatch(
      /if \(!sampleBase\.ok\) refusal = `\$\{sampleBase\.error\.reason\}: \$\{sampleBase\.error\.detail\}`/,
    );
    // A sample is built only from a loaded context.
    expect(PAGE).toMatch(/const sample = ctx === undefined \? undefined : sampleFor\(/);
  });
});
