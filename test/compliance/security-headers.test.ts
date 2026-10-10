/**
 * SR-027: every app answers with the browser security headers, and the
 * Content-Security-Policy is strict.
 *
 * Each app's own middleware is run on a request, as Next runs it. A page, an
 * API route and a redirect all carry the headers; the nonce is fresh per
 * response and is forwarded on the request, which is where Next reads it to
 * stamp its scripts. (A production build was also served and loaded in a
 * browser: every script carried the nonce and no violation was reported.)
 */
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { contentSecurityPolicy, identityProviderOrigins } from '../../packages/auth/security-headers.ts';

vi.stubEnv('OPS_SESSION_SECRET', 'd4'.repeat(32));

const APPS = {
  ops: () => import('../../apps/ops/src/middleware.ts'),
  admin: () => import('../../apps/admin/src/middleware.ts'),
  consumer: () => import('../../apps/consumer/src/middleware.ts'),
  sme: () => import('../../apps/sme/src/middleware.ts'),
} as const;

const REQUIRED = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
] as const;

const directives = (policy: string): Map<string, string> =>
  new Map(
    policy.split(';').map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name as string, rest.join(' ')];
    }),
  );

describe('browser security headers on every app (SR-027)', () => {
  for (const [app, load] of Object.entries(APPS)) {
    for (const path of ['/en', '/en/sign-in', '/api/anything', '/_next/static/chunks/main-app.js']) {
      it(`${app} ${path}`, async () => {
        const { middleware } = await load();
        const request = new NextRequest(`https://${app}.sanad.test${path}`);
        const response = middleware(request);
        for (const h of REQUIRED) expect(response.headers.get(h), `${app} ${path} ${h}`).toBeTruthy();
        expect(response.headers.get('x-frame-options')).toBe('DENY');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        const csp = directives(response.headers.get('content-security-policy') as string);
        expect(csp.get('frame-ancestors')).toBe("'none'");
        expect(csp.get('object-src')).toBe("'none'");
        expect(csp.get('base-uri')).toBe("'self'");
        expect(csp.get('script-src')).toMatch(/'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/);
        expect(csp.get('script-src')).not.toMatch(/unsafe-inline|\*/);
        // A pass forwards the policy on the request, where Next reads the nonce for its own scripts.
        const forwarded = response.headers.get('x-middleware-request-content-security-policy');
        if (response.status === 200) expect(forwarded).toBe(response.headers.get('content-security-policy'));
      });
    }

    it(`${app} issues a fresh nonce per response`, async () => {
      const { middleware } = await load();
      const nonce = () =>
        middleware(new NextRequest(`https://${app}.sanad.test/en/sign-in`))
          .headers.get('content-security-policy')
          ?.match(/nonce-([^']+)/)?.[1];
      expect(nonce()).not.toBe(nonce());
    });
  }

  it('lets staff sign-in forms reach the identity provider, and nothing else', async () => {
    for (const app of ['ops', 'admin'] as const) {
      const { middleware } = await APPS[app]();
      const csp = directives(
        middleware(new NextRequest(`https://${app}.sanad.test/en/sign-in`)).headers.get(
          'content-security-policy',
        ) as string,
      );
      expect(csp.get('form-action')).toBe("'self' https://login.microsoftonline.com");
    }
    for (const app of ['consumer', 'sme'] as const) {
      const { middleware } = await APPS[app]();
      const csp = directives(
        middleware(new NextRequest(`https://${app}.sanad.test/en`)).headers.get('content-security-policy') as string,
      );
      expect(csp.get('form-action')).toBe("'self'");
    }
  });

  it('allows unsafe-eval and websockets only in development, and HSTS only outside it', () => {
    expect(contentSecurityPolicy('n', { development: true })).toMatch(/'unsafe-eval'.*connect-src 'self' ws: wss:/);
    expect(contentSecurityPolicy('n', { development: false })).not.toMatch(/unsafe-eval|ws:/);
  });

  it('runs on every path, static assets included, and the framework does not announce itself', async () => {
    const { readFileSync } = await import('node:fs');
    for (const app of Object.keys(APPS)) {
      const { config } = (await APPS[app as keyof typeof APPS]()) as { config: { matcher: string[] } };
      expect(config.matcher, app).toEqual(['/:path*']);
      const nextConfig = readFileSync(new URL(`../../apps/${app}/next.config.mjs`, import.meta.url), 'utf8');
      expect(nextConfig, app).toMatch(/poweredByHeader:\s*false/);
    }
  });

  it('takes only https origins from the configured issuers and the override', () => {
    expect(
      identityProviderOrigins(
        ['development:bank-a', 'https://login.example.test/tenant/v2.0', 'https://login.example.test/other'],
        ' https://idp.example.test/x , javascript:alert(1), http://plain.test',
      ),
    ).toEqual(['https://idp.example.test', 'https://login.example.test']);
  });
});
