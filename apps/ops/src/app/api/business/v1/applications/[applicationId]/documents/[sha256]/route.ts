/**
 * Serves an uploaded document of a business application, by the hash of its
 * bytes.
 *
 * For a signed-in member of staff of the application's own institution only:
 * no session is 401; another institution's application, or a hash the
 * application does not hold, is 404, as if it did not exist. The bytes are
 * checked against their recorded hash before they are served (SR-020), and
 * served inline under the type read from their signature at upload, never
 * one the store declares.
 */
import { randomUUID } from 'node:crypto';

import { readBusinessDocument } from '../../../../../../../../server/business-storage.ts';
import { currentStaff } from '../../../../../../../../server/session.ts';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly applicationId: string; readonly sha256: string }> },
): Promise<Response> {
  const staff = await currentStaff();
  if (staff === undefined) return new Response(null, { status: 401, headers: NO_STORE });
  const { applicationId, sha256 } = await context.params;
  const read = await readBusinessDocument(staff.tenantId, applicationId, sha256, randomUUID());
  if (read.kind === 'NOT_HELD') return new Response(null, { status: 404, headers: NO_STORE });
  // Not the bytes that were recorded: never served.
  if (read.kind === 'TAMPERED') return new Response(null, { status: 409, headers: NO_STORE });
  if (read.kind !== 'BYTES') return new Response(null, { status: 503, headers: NO_STORE });
  const extension = read.mediaType === 'application/pdf' ? 'pdf' : read.mediaType === 'image/png' ? 'png' : 'jpg';
  return new Response(Buffer.from(read.bytes), {
    headers: {
      ...NO_STORE,
      'content-type': read.mediaType,
      'content-disposition': `inline; filename="${applicationId.replace(/[^A-Za-z0-9-]/g, '')}-${sha256.slice(0, 12)}.${extension}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}
