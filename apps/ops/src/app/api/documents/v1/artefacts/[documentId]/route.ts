/**
 * Serves a document's bytes to the viewer. Development: the synthetic samples
 * only, by id; nothing else on disk is reachable through this route.
 */
import { findViewerDocument, readSampleBytes } from '../../../../../../server/documents.ts';

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly documentId: string }> },
): Promise<Response> {
  const { documentId } = await context.params;
  const doc = findViewerDocument(documentId);
  if (doc === undefined) return new Response(null, { status: 404 });
  const bytes = readSampleBytes(doc);
  if (bytes === undefined) return new Response('samples not generated: npm run nutrient:samples', { status: 503 });
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'no-store',
      'content-disposition': `inline; filename="${doc.fileName}"`,
    },
  });
}
