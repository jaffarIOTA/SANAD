/**
 * Every Admin response carries the browser security headers (SR-027): a strict
 * nonce-based Content-Security-Policy, no framing, HSTS. Sign-in is checked by
 * the pages and actions themselves; this only sets headers.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { isDevelopment, staffFormActionOrigins, withSecurityHeaders } from '@sanad/auth/next-security.ts';

export const config = {
  // Every path, Next's static assets included: they need nosniff and the rest as much as pages do (ZAP, SR-032).
  matcher: ['/:path*'],
  runtime: 'nodejs',
};

// Staff sign-in and sign-out forms lead to the institution's identity provider.
const SECURITY = { formActionOrigins: staffFormActionOrigins(), development: isDevelopment() } as const;

export function middleware(request: NextRequest): NextResponse {
  return withSecurityHeaders(request, SECURITY);
}
