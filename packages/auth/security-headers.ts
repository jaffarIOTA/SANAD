/**
 * Browser security headers for every app (SR-027).
 *
 * One builder, four apps, so they cannot drift. The middleware of each app
 * calls `securityHeaders()` per request: a fresh nonce goes into a strict
 * Content-Security-Policy, and Next stamps that nonce on its own scripts when
 * it finds the policy on the request. Each app's locale layout renders
 * dynamically, so no page is served from a build-time render without it.
 *
 * - script-src: the nonce and 'strict-dynamic'. No 'unsafe-inline'. Development
 *   adds 'unsafe-eval', which Next's fast refresh needs, and never production.
 * - style-src keeps 'unsafe-inline': React writes style attributes, which a
 *   nonce cannot cover. Scripts, not styles, are what an injection runs.
 * - frame-ancestors 'none' and X-Frame-Options DENY: no approval or admin
 *   decision can be framed.
 * - form-action: this origin, plus the identity providers a staff sign-in form
 *   redirects to, because browsers apply form-action to that redirect.
 */

import { randomBytes } from 'node:crypto';

export interface SecurityHeaderOptions {
  /** Origins a form may submit or redirect to besides this one: the staff identity providers. */
  readonly formActionOrigins?: readonly string[];
  readonly development?: boolean;
  /** `no-referrer` for the internal apps; the public ones may keep their origin on outbound links. */
  readonly referrerPolicy?: 'no-referrer' | 'strict-origin-when-cross-origin';
}

/** 128 random bits, base64: a CSP nonce. */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

export function contentSecurityPolicy(nonce: string, options: SecurityHeaderOptions = {}): string {
  const dev = options.development === true;
  const formAction = ["'self'", ...(options.formActionOrigins ?? [])].join(' ');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    // No upgrade-insecure-requests: HSTS and TLS-only hosting already keep the apps on https, and the
    // directive would break a plain-http local run of a production build.
  ].join('; ');
}

/** Every header for one response, the policy carrying `nonce`. */
export function securityHeaders(nonce: string, options: SecurityHeaderOptions = {}): Readonly<Record<string, string>> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(nonce, options),
    // Two years, every subdomain; the apps are only ever served over TLS in a deployment.
    ...(options.development === true ? {} : { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' }),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': options.referrerPolicy ?? 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/** The origin of each https issuer: where a staff sign-in or sign-out redirects. Development issuers have none. */
export function identityProviderOrigins(issuers: readonly string[], extra = ''): readonly string[] {
  const origins = new Set<string>();
  for (const value of [...issuers, ...extra.split(',')]) {
    const v = value.trim();
    if (!v.startsWith('https://')) continue;
    try {
      origins.add(new URL(v).origin);
    } catch {
      // Not a URL; nothing to allow.
    }
  }
  return [...origins].sort();
}
