/**
 * The new ports carry nothing they must not.
 *
 * A port is where a vendor's world meets ours, so it is where a rate, a
 * personal identifier or a credential would first appear if it were going to.
 * These scan the port source for field names that would be a control failure
 * on day one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORTS = ['counterparty-registry', 'credit-bureau', 'screening', 'notifications', 'applicant-snapshot'];
const src = (p: string) => readFileSync(`${ROOT}core/ports/${p}.ts`, 'utf8');
const fields = (s: string) => [...s.matchAll(/^\s*readonly\s+(\w+)\??:/gm)].map((m) => m[1] ?? '');

describe('ports declare no rate-shaped field', () => {
  it.each(PORTS)('%s', (p) => {
    const bad = fields(src(p)).filter((f) => /rate|percent|margin|yield|coupon/i.test(f) || /^apr$/i.test(f));
    expect(bad).toEqual([]);
  });
});

describe('ports carry identifiers by reference, not by value', () => {
  it.each(PORTS)('%s has no national-id, iqama, passport, phone or email field', (p) => {
    const bad = fields(src(p)).filter((f) => /nationalId|iqama|passport|phone|mobile|email|dateOfBirth|dob/i.test(f));
    expect(bad).toEqual([]);
  });
  it('bureau and screening require a consent reference on the request', () => {
    expect(fields(src('credit-bureau'))).toContain('consentId');
    expect(fields(src('screening'))).toContain('consentId');
  });
  it('bureau unavailability is a typed outcome, never a decline', () => {
    expect(src('credit-bureau')).toMatch(/kind: 'UNAVAILABLE'/);
  });
});
