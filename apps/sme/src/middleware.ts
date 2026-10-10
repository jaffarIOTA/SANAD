/**
 * Every SME portal response carries the browser security headers (SR-027): a
 * strict nonce-based Content-Security-Policy, no framing, HSTS.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { isDevelopment, withSecurityHeaders } from '@sanad/auth/next-security.ts';

export const config = {
  // Every path, Next's static assets included: they need nosniff and the rest as much as pages do (ZAP, SR-032).
  matcher: ['/:path*'],
  runtime: 'nodejs',
};

const SECURITY = { development: isDevelopment(), referrerPolicy: 'strict-origin-when-cross-origin' } as const;

export function middleware(request: NextRequest): NextResponse {
  return withSecurityHeaders(request, SECURITY);
}
