/**
 * SR-016: an inbound callback verifies its signature before it parses. Any
 * route handler whose path names a webhook or callback from a rail or partner
 * must call `verifyWebhook` (adapters/kernel/webhook-signature.ts) and must
 * not read the body as JSON before it does. Staff single sign-on's own
 * callback is the provider redirecting a browser, verified by its state and
 * code (packages/auth/staff-oidc.ts), and is not one of these.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function routes(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.next') continue;
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e === 'route.ts') out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const INBOUND = /(webhook|callback|notif(y|ication)s?-?in)/i;
const STAFF_SIGN_IN = /\/sign-in\/callback\/route\.ts$/;

describe('inbound callbacks verify before parsing (SR-016)', () => {
  const inbound = ['apps', 'services']
    .flatMap((d) => routes(d))
    .map((f) => relative(ROOT, f))
    .filter((f) => INBOUND.test(f) && !STAFF_SIGN_IN.test(f));

  const verifiesBeforeParsing = (text: string): boolean => {
    const verified = text.indexOf('verifyWebhook(');
    const parsed = text.search(/\.json\(\)|JSON\.parse\(/);
    return verified >= 0 && (parsed < 0 || parsed > verified);
  };

  /**
   * Shared verifiers a route may delegate to instead (the Wasl webhooks, W4a): the route then reads its
   * fields only from what the helper returns and parses nothing itself, and the helper is held to the same rule.
   */
  const VERIFIERS: Readonly<Record<string, string>> = {
    'verifiedDelivery(': 'apps/ops/src/server/wasl-webhooks.ts',
  };

  it('every inbound callback route calls verifyWebhook before reading its body as JSON', () => {
    const offenders = inbound.filter((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8');
      if (verifiesBeforeParsing(text)) return false;
      const helper = Object.entries(VERIFIERS).find(([call]) => text.includes(call));
      if (helper === undefined) return true;
      const parsesItself = /\.json\(\)|JSON\.parse\(|request\.text\(\)/.test(text);
      return parsesItself || !verifiesBeforeParsing(readFileSync(join(ROOT, helper[1]), 'utf8'));
    });
    expect(offenders).toEqual([]);
  });

  it('the staff sign-in callback is the only callback route exempted', () => {
    const exempt = ['apps']
      .flatMap((d) => routes(d))
      .map((f) => relative(ROOT, f))
      .filter((f) => INBOUND.test(f) && STAFF_SIGN_IN.test(f));
    for (const f of exempt) expect(f).toMatch(/^apps\/(ops|admin)\/src\/app\/sign-in\/callback\/route\.ts$/);
  });
});
