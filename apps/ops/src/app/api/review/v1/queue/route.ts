import { correlation, json, staffOr401, toWire } from '../shared.ts';
import { listRequests, syncStore } from '../../../../../server/store.ts';

const VIEWS: Readonly<Record<string, readonly string[]>> = {
  review: ['AWAITING_REVIEW'],
  servicing: ['AWAITING_SERVICING_RESPONSE'],
  maker: ['RETURNED_TO_MAKER', 'KEYING'],
  information: ['PENDING_INFORMATION'],
  failures: ['SERVICING_UNAVAILABLE'],
  breached: [
    'AWAITING_SERVICING_RESPONSE',
    'AWAITING_REVIEW',
    'RETURNED_TO_MAKER',
    'PENDING_INFORMATION',
    'SERVICING_UNAVAILABLE',
  ],
  decided: ['APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
};

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlation(request);
  const staff = staffOr401(request, correlationId);
  if (staff instanceof Response) return staff;
  const view = new URL(request.url).searchParams.get('view') ?? 'review';
  const states = VIEWS[view] ?? VIEWS['review'] ?? [];
  await syncStore();
  // Oldest first: a work queue, not a feed. Nothing starves.
  const items = listRequests()
    // The caller's own institution only (SEC-TM08).
    .filter((r) => r.tenantId === staff.tenantId && states.includes(r.state))
    .sort((a, b) => (a.raisedAtEpochSeconds < b.raisedAtEpochSeconds ? -1 : 1))
    .map(toWire);
  return json(200, { items }, correlationId);
}
