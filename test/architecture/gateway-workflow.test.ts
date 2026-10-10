/**
 * SR-022: the API Connect discovery workflow is configured to discover the
 * intended APIs, with least privilege.
 *
 * Every file it names exists and is an API definition; it supplies every input
 * the pinned action requires; it reads the repository and nothing more; and no
 * event value is interpolated into a script.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const text = readFileSync(`${ROOT}.github/workflows/ibm.yml`, 'utf8');
const workflow = parse(text) as {
  permissions?: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, { steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }>;
};
const action = Object.values(workflow.jobs)
  .flatMap((j) => j.steps)
  .find((s) => s.uses?.startsWith('ibm-apiconnect/apic-discovery-action@'));

describe('the API Connect discovery workflow (SR-022)', () => {
  it('names only API definitions that exist', () => {
    const files = workflow.env['API_FILES']?.split(',').map((f) => f.trim()) ?? [];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(existsSync(`${ROOT}${f}`), f).toBe(true);
      expect(readFileSync(`${ROOT}${f}`, 'utf8'), f).toMatch(/^(openapi|swagger):/m);
    }
    expect(existsSync(`${ROOT}${workflow.env['API_FOLDERS'] ?? ''}`)).toBe(true);
  });

  it('supplies every input the pinned action requires', () => {
    expect(action).toBeDefined();
    for (const input of ['api_host', 'provider_org', 'api_files', 'api_folders'])
      expect(action?.with?.[input], input).toBeTruthy();
  });

  it('reads the repository and nothing more', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('interpolates no event value into a script', () => {
    for (const step of Object.values(workflow.jobs).flatMap((j) => j.steps))
      expect(step.run ?? '', step.run ?? '').not.toMatch(/\$\{\{\s*(github\.event|steps\.)/);
  });
});
