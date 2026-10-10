/**
 * The security headers, applied by an app's middleware (SR-027).
 *
 * The policy goes on the request as well as the response: Next reads the nonce
 * from the request's Content-Security-Policy and stamps it on the scripts it
 * renders. `decide` is the app's own front-door logic; whatever it returns
 * (pass, redirect) carries the headers.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { TENANT_CODES, loadStaffIdentity } from '../../config/loader.ts';

import { type SecurityHeaderOptions, identityProviderOrigins, newNonce, securityHeaders } from './security-headers.ts';

export function withSecurityHeaders(
  request: NextRequest,
  options: SecurityHeaderOptions,
  decide: (pass: () => NextResponse) => NextResponse = (pass) => pass(),
): NextResponse {
  const headers = securityHeaders(newNonce(), options);
  const pass = (): NextResponse => {
    const forwarded = new Headers(request.headers);
    forwarded.set('Content-Security-Policy', headers['Content-Security-Policy'] as string);
    return NextResponse.next({ request: { headers: forwarded } });
  };
  const response = decide(pass);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const isDevelopment = (): boolean => process.env['NODE_ENV'] !== 'production';

/**
 * Where a staff sign-in or sign-out form may lead: each tenant's deployed identity
 * provider from the checked-in configuration, plus SANAD_CSP_FORM_ACTION_ORIGINS
 * (comma-separated) for a provider approved later as a configuration revision.
 */
export function staffFormActionOrigins(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const issuers: string[] = [];
  for (const tenant of TENANT_CODES) {
    const identity = loadStaffIdentity(tenant, 'DEPLOYED');
    if (identity.ok) issuers.push(identity.value.provider.issuer);
  }
  return identityProviderOrigins(issuers, env['SANAD_CSP_FORM_ACTION_ORIGINS'] ?? '');
}
