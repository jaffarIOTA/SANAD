/**
 * The closing steps a disbursement needs (UAE M5a), through the public
 * service: the payee account recorded by the officer against a document on
 * file and confirmed by the checker. The IBAN is the published example UAE
 * IBAN — synthetic.
 */
import { expectOk } from '../../core/kernel/result.ts';
import { confirmPayee, getApplication, recordPayee } from '../../apps/ops/src/server/business.ts';

export const EXAMPLE_AE_IBAN = 'AE070331234567890123456';

export async function preparePayee(tenant: 'sme-fund-ae', applicationId: string, officer: string, checker: string): Promise<void> {
  const view = await getApplication(tenant, applicationId);
  const evidenceRef = view?.documents[0]?.documentRef;
  if (evidenceRef === undefined) throw new Error('no document on the application to evidence the payee');
  expectOk(await recordPayee(tenant, applicationId, { iban: EXAMPLE_AE_IBAN, accountName: 'Example Trading LLC', evidenceRef }, officer));
  expectOk(await confirmPayee(tenant, applicationId, checker));
}
