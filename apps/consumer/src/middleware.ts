/**
 * Every consumer response carries the browser security headers (SR-027): a
 * strict nonce-based Content-Security-Policy, no framing, HSTS. The applicant's
 * forms stay on this origin.
 */

import type { NextRequest, NextResponse } from 'next/server';

import { isDevelopment, withSecurityHeaders } from '@sanad/auth/next-security.ts';

export const config = {
  matcher: ['/((?!_next/static/|_next/image|favicon\\.ico$).*)'],
  runtime: 'nodejs',
};

const SECURITY = { development: isDevelopment(), referrerPolicy: 'strict-origin-when-cross-origin' } as const;

export function middleware(request: NextRequest): NextResponse {
  return withSecurityHeaders(request, SECURITY);
}
