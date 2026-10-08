/**
 * The workbench's front door. Every page request needs a valid staff session;
 * without one the browser is sent to sign in, in the locale it asked for.
 *
 * - `/api/*` is not redirected: those routes authenticate their own callers
 *   (staff bearer, partner credential) and answer 401 as an API should.
 * - Next's own assets and static files pass.
 * - The sign-in page itself passes, or nothing could ever sign in.
 *
 * Runs on the Node.js runtime so it opens the session with the same sealed
 * token code as the server components (no second implementation to drift). It
 * is the first line, not the only one: every server action and page reads the
 * session again on the server.
 */

import { type NextRequest, NextResponse } from 'next/server';

import { STAFF_SESSION_COOKIE, epochNow, openStaffSession } from './server/staff-session.ts';

export const config = {
  matcher: ['/((?!api/|api$|_next/|favicon\\.ico$).*)'],
  runtime: 'nodejs',
};

const LOCALES = new Set(['ar', 'en']);
const STATIC_FILE = /\/[^/]+\.[A-Za-z0-9]{1,8}$/;

export type FrontDoor =
  { readonly kind: 'PASS' } | { readonly kind: 'SIGN_IN'; readonly location: string; readonly clearCookie: boolean };

/** The decision, apart from the framework, so it can be tested as a table. */
export function frontDoor(pathname: string, cookieValue: string | undefined, nowEpochSeconds: bigint): FrontDoor {
  if (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    STATIC_FILE.test(pathname)
  )
    return { kind: 'PASS' };
  const first = pathname.split('/')[1] ?? '';
  const locale = LOCALES.has(first) ? first : 'ar';
  if (LOCALES.has(first) && (pathname === `/${first}/sign-in` || pathname === `/${first}/sign-in/`))
    return { kind: 'PASS' };
  const opened = openStaffSession(cookieValue, nowEpochSeconds);
  if (opened.kind === 'VALID') return { kind: 'PASS' };
  return {
    kind: 'SIGN_IN',
    location: `/${locale}/sign-in?reason=SESSION_REQUIRED`,
    clearCookie: cookieValue !== undefined,
  };
}

export function middleware(request: NextRequest): NextResponse {
  const decision = frontDoor(request.nextUrl.pathname, request.cookies.get(STAFF_SESSION_COOKIE)?.value, epochNow());
  if (decision.kind === 'PASS') return NextResponse.next();
  const response = NextResponse.redirect(new URL(decision.location, request.url), 303);
  if (decision.clearCookie) response.cookies.delete(STAFF_SESSION_COOKIE);
  return response;
}
