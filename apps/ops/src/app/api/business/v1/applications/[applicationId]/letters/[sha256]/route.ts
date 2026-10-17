/**
 * Serves a rendered offer-letter PDF of a business application, by the hash
 * of its bytes. For a signed-in member of staff of the application's own
 * institution only: no session is 401; another institution's application, or
 * a hash the application has not rendered, is 404. The bytes are checked
 * against their recorded hash before they are served (SR-020).
 */
import { randomUUID } from 'node:crypto';

import { readOfferPdf } from '../../../../../../../../server/business-letter-pdf.ts';
import { currentStaff } from '../../../../../../../../server/session.ts';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly applicationId: string; readonly sha256: string }> },
): Promise<Response> {
  const staff = await currentStaff();
  if (staff === undefined) return new Response(null, { status: 401, headers: NO_STORE });
  const { applicationId, sha256 } = await context.params;
  const read = await readOfferPdf(staff.tenantId, applicationId, sha256, randomUUID());
  if (read.kind === 'NOT_HELD') return new Response(null, { status: 404, headers: NO_STORE });
  if (read.kind === 'TAMPERED') return new Response(null, { status: 409, headers: NO_STORE });
  if (read.kind !== 'BYTES') return new Response(null, { status: 503, headers: NO_STORE });
  return new Response(Buffer.from(read.bytes), {
    headers: {
      ...NO_STORE,
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="offer-letter-${applicationId.replace(/[^A-Za-z0-9-]/g, '')}-${sha256.slice(0, 12)}.pdf"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
