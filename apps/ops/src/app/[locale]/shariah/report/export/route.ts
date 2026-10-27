/**
 * The Board's Shariah compliance report as JSON (Wasl W6c; BR-F08), for the
 * institution's own annual-report format. Whole numbers as strings; counts,
 * references and codes only. The signed-in person's own institution, and only
 * the Shariah auditor or reviewers.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { civilDateOf } from '@sanad/origination/civil-date.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { boardReport, boardReportJson } from '@sanad/origination/wasl/audit.ts';

import { permits } from '../../../../../server/authority.ts';
import { currentStaff } from '../../../../../server/session.ts';

export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request): Promise<Response> {
  const staff = await currentStaff();
  if (staff === undefined) return new Response('Sign in to download the report', { status: 401 });
  if (!permits(staff, 'SHARIAH_AUDIT_READ').allowed)
    return new Response('The report is for the Shariah auditor and reviewers', { status: 403 });
  const tenant = staff.tenantId as TenantCode;
  const url = new URL(request.url);
  const today = civilDateOf(tenant, hostClockInstant());
  const toParam = url.searchParams.get('to') ?? '';
  const fromParam = url.searchParams.get('from') ?? '';
  const to = DATE.test(toParam) ? toParam : today;
  const from = DATE.test(fromParam) ? fromParam : `${to.slice(0, 4)}-01-01`;
  const report = await boardReport(tenant, from, to);
  return new Response(JSON.stringify(boardReportJson(report), null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="shariah-board-report-${from}-${to}.json"`,
      'cache-control': 'no-store',
    },
  });
}
