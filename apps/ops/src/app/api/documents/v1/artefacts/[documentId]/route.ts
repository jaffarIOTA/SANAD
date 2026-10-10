/**
 * Serves a document's bytes to the viewer. Development: the synthetic samples
 * only, by id; nothing else on disk is reachable through this route.
 *
 * For a signed-in member of staff of the document's own institution only:
 * no session is 401, another institution's document is 404, as if it did not
 * exist. The bytes are checked against the hash they were recorded with before
 * they are served (SR-020).
 */
import { findViewerDocument, readSampleBytes } from '../../../../../../server/documents.ts';
import { currentStaff } from '../../../../../../server/session.ts';

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly documentId: string }> },
): Promise<Response> {
  const staff = await currentStaff();
  if (staff === undefined) return new Response(null, { status: 401, headers: { 'cache-control': 'no-store' } });
  const { documentId } = await context.params;
  const doc = findViewerDocument(documentId);
  if (doc === undefined || doc.tenantId !== staff.tenantId) return new Response(null, { status: 404 });
  const bytes = readSampleBytes(doc);
  if (bytes === 'MISSING') return new Response('samples not generated: npm run nutrient:samples', { status: 503 });
  // Not the bytes that were recorded: never served.
  if (bytes === 'TAMPERED') return new Response(null, { status: 409 });
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'no-store',
      'content-disposition': `inline; filename="${doc.fileName}"`,
    },
  });
}
