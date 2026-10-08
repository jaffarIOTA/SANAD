/**
 * The pipeline as CSV, for the dashboard's Export.
 *
 * Business-level fields only: the application reference, the business name,
 * product variant, purpose, amount, stage, status and turnaround. No owner,
 * no contact, no registration or identity reference — an export travels
 * further than the screen it came from.
 *
 * The tenant is the deployment's active tenant (ADR 0005), never a parameter.
 * Amounts are formatted from minor units by string arithmetic, no float.
 */

import { formatMinorUnits } from '@sanad/design/Money.tsx';

import { listApplications, productVariants, syncBusiness } from '../../../../server/business.ts';
import { turnaroundSeconds, wholeDays } from '../../../../server/business-dashboard.ts';
import { workbenchJurisdiction } from '../../../../server/jurisdiction.ts';
import { developmentAttestation } from '../../../../server/store.ts';

export const dynamic = 'force-dynamic';

/**
 * RFC 4180 quoting, after neutralising formula injection (OWASP "CSV
 * Injection"): a cell beginning with = + - @, a tab or a carriage return is
 * prefixed with a single quote so a spreadsheet treats it as text.
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export async function GET(): Promise<Response> {
  const j = await workbenchJurisdiction();
  if (j.tenant === undefined) return new Response('No institution is onboarded under this jurisdiction', { status: 404 });
  await syncBusiness(j.tenant);
  const [views, variants] = await Promise.all([listApplications(j.tenant), productVariants(j.tenant)]);
  const now = developmentAttestation().epochSeconds;
  const header = ['applicationId', 'business', 'variant', 'purpose', 'amount', 'currency', 'stage', 'status', 'receivedOn', 'turnaroundDays'];
  const rows = views.map((v) => {
    const a = v.application;
    return [
      a.applicationId,
      a.applicant.businessNameEn,
      variants.get(a.variantCode)?.nameEn ?? a.variantCode,
      a.purpose,
      formatMinorUnits(a.requested, 'latin').replace(/,/g, ''),
      a.requested.currency,
      String(v.displayStage),
      a.status,
      new Date(Number(a.receivedAtEpochSeconds) * 1000).toISOString().slice(0, 10),
      String(wholeDays(turnaroundSeconds(v, now))),
    ].map(cell).join(',');
  });
  const body = [header.join(','), ...rows].join('\r\n');
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="pipeline-${j.tenant}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
