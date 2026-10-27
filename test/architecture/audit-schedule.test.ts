/**
 * SR-011: the audit chain is verified on a schedule in the hosted environment,
 * and someone is told when it is broken, when the check cannot run, and when it
 * does not run at all. Read from the template and the deploy workflow, which
 * are what the environment is built from.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = process.cwd();
const bicep = readFileSync(join(ROOT, 'deploy/azure/main.bicep'), 'utf8');
const resource = (symbol: string): string => {
  const start = bicep.indexOf(`resource ${symbol} `);
  expect(start, `resource ${symbol}`).toBeGreaterThan(-1);
  const next = bicep.indexOf('\nresource ', start + 1);
  return bicep.slice(start, next === -1 ? undefined : next);
};

describe('the daily audit-chain check (SR-011)', () => {
  it('is a scheduled job running both verifiers, once, with no retry', () => {
    const job = resource('auditJob');
    expect(job).toContain("'Microsoft.App/jobs@");
    expect(job).toContain("triggerType: 'Schedule'");
    expect(job).toContain('cronExpression: auditCron');
    expect(job).toContain('replicaRetryLimit: 0');
    expect(job).toContain("'services/origination/src/audit-verify-cli.ts'");
    expect(job).toContain("secretRef: 'sanad-database-url'");
    expect(job).toContain('/sanad-worker:');
  });

  it('alerts on a break, on a run that could not reach the database, and on a day with no verdict', () => {
    const alert = resource('auditAlert');
    expect(alert).toContain("Log_s has 'BROKEN'");
    expect(alert).toContain("Log_s has 'could not run'");
    expect(alert).toContain('verdicts == 0');
    expect(alert).toContain('ago(26h)');
    expect(alert).toContain('auditActionGroup.id');
    // The words it looks for are the ones the verifier prints.
    const cli = readFileSync(join(ROOT, 'services/origination/src/audit-verify-cli.ts'), 'utf8');
    expect(cli).toContain("'BROKEN'");
    expect(cli).toContain('could not run');
    expect(cli).toContain('`audit ${t.code}');
  });

  it('ships the image the job runs, scanned, with every release', () => {
    const wf = parse(readFileSync(join(ROOT, '.github/workflows/deploy-azure.yml'), 'utf8')) as {
      jobs: Record<string, { steps: { run?: string; uses?: string }[] }>;
    };
    const steps = wf.jobs['worker']?.steps ?? [];
    expect(steps.some((s) => s.run?.includes('services/worker/Containerfile'))).toBe(true);
    expect(steps.some((s) => s.uses?.startsWith('aquasecurity/trivy-action@'))).toBe(true);
    expect(steps.some((s) => s.run?.includes('job-sanad-audit-verify'))).toBe(true);
  });
});
