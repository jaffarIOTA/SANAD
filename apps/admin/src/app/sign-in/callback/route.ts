/**
 * The OpenID Connect redirect URI: `<ADMIN_PUBLIC_ORIGIN>/sign-in/callback`.
 * One path for both locales; the locale travels in the sealed state.
 */

import { completeSingleSignOn } from '../../../server/single-sign-on.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Promise<Response> {
  return completeSingleSignOn(request);
}
