/**
 * The licence banner (ADR 0006 §4), as the browser receives it: in Arabic and
 * in English, from the core wording, with nothing while the licence is valid.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LicenceBanner } from '@sanad/design/LicenceBanner.tsx';
import { licenceBanner } from '@sanad/core/licensing/explain.ts';
import { parseSignedFile } from '@sanad/core/licensing/licence.ts';
import { licenceState } from '@sanad/core/licensing/state.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

import { INSTALLATION, annual, at, testIssuer, testVerifier } from '../support/licensing.ts';

const issuer = testIssuer();
const installation = { installationId: INSTALLATION, verifier: testVerifier(issuer) };
const history = [expectOk(parseSignedFile(issuer.signLicence(annual())))];
const bannerAt = (date: string) => licenceBanner(licenceState(history, installation, at(date), undefined));

describe('<LicenceBanner>', () => {
  it('renders nothing while the licence is valid', () => {
    expect(renderToStaticMarkup(<LicenceBanner banner={bannerAt('2026-06-01')} arabic />)).toBe('');
  });

  it('warns, in Arabic first, while expiring', () => {
    const html = renderToStaticMarkup(<LicenceBanner banner={bannerAt('2026-12-20')} arabic href="/ar/licence" />);
    expect(html).toContain('data-tone="attention"');
    expect(html).toContain('الترخيص');
    expect(html).toContain('href="/ar/licence"');
    expect(html).not.toMatch(/\b(ml|mr|pl|pr|left|right)-/);
  });

  it('alerts, in English, once new business is blocked — and says servicing continues', () => {
    const html = renderToStaticMarkup(<LicenceBanner banner={bannerAt('2027-03-01')} arabic={false} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-tone="blocked"');
    expect(html).toContain('repayments, collections and regulatory reporting continue');
  });
});
