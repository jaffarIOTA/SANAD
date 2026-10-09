/**
 * The post-logout redirect URI: `<ADMIN_PUBLIC_ORIGIN>/sign-in/signed-out`.
 * The provider returns here after RP-initiated logout.
 */

import { signedOut } from '../../../server/single-sign-on.ts';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  return signedOut(request);
}
