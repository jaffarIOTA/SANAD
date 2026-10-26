/**
 * One transaction's audit pack, as a file (Wasl W6c; BR-F05): its replay and
 * what it rests on, with a manifest of each part's SHA-256 so a changed copy
 * shows it (services/origination/src/wasl/audit.ts).
 *
 * The signed-in person's own institution only, never a parameter, and only
 * for the Board's auditor or a Shariah reviewer. No personal datum: parties
 * are commercial registrations and references; people are principal ids.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { auditPack } from '@sanad/origination/wasl/audit.ts';

import { permits } from '../../../../../../server/authority.ts';
import { currentStaff } from '../../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ readonly transactionRef: string }> },
): Promise<Response> {
  const staff = await currentStaff();
  if (staff === undefined) return new Response('Sign in to export an audit pack', { status: 401 });
  if (!permits(staff, 'SHARIAH_AUDIT_READ').allowed)
    return new Response('The audit pack is for the Shariah auditor and reviewers', { status: 403 });
  const { transactionRef } = await params;
  const ref = decodeURIComponent(transactionRef).slice(0, 40);
  const pack = await auditPack(staff.tenantId as TenantCode, ref, staff.principalId);
  if (!pack.ok) return new Response('No such transaction', { status: 404 });
  return new Response(JSON.stringify(pack.value, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="shariah-audit-pack-${/^[\w-]+$/.test(ref) ? ref : 'transaction'}.json"`,
      'cache-control': 'no-store',
    },
  });
}
