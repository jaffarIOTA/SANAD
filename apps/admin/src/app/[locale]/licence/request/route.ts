/**
 * GET — the licence request file (ADR 0006 §2), downloaded by an administrator
 * and sent to the issuer to ask for a licence, a POC extension or a renewal.
 *
 * It carries the installation id, the licence in force, the deployment's
 * jurisdiction and the product version — no customer, applicant, transaction
 * or staff data (core/licensing/request-file.ts).
 */

import { currentLicenceRequestFile } from '@sanad/origination/licensing.ts';

import { currentAdmin } from '../../../../server/session.ts';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  if ((await currentAdmin()) === undefined) return new Response('Sign in first.', { status: 401 });
  const file = await currentLicenceRequestFile();
  return new Response(`${JSON.stringify(file, null, 2)}\n`, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="sanad-licence-request-${file.installationId}.json"`,
      'cache-control': 'no-store',
    },
  });
}
