/**
 * The closing steps a disbursement needs (UAE M5a), through the public
 * service: the payee account recorded by the officer against a document on
 * file and confirmed by the checker. The IBAN is the published example UAE
 * IBAN — synthetic.
 */
import type { TenantCode } from '../../config/loader.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { confirmPayee, getApplication, recordPayee } from '../../apps/ops/src/server/business.ts';

export const EXAMPLE_AE_IBAN = 'AE070331234567890123456';

/** The published example Saudi IBAN — synthetic. */
export const EXAMPLE_SA_IBAN = 'SA0380000000608010167519';

export async function preparePayee(
  tenant: TenantCode,
  applicationId: string,
  officer: string,
  checker: string,
  iban: string = EXAMPLE_AE_IBAN,
): Promise<void> {
  const view = await getApplication(tenant, applicationId);
  const evidenceRef = view?.documents[0]?.documentRef;
  if (evidenceRef === undefined) throw new Error('no document on the application to evidence the payee');
  expectOk(await recordPayee(tenant, applicationId, { iban, accountName: 'Example Trading LLC', evidenceRef }, officer));
  expectOk(await confirmPayee(tenant, applicationId, checker));
}
