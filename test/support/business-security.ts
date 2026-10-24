/**
 * Meets a business application's security requirements through the public
 * service, as an officer and a checker would: whatever the variant requires,
 * recorded and confirmed by two people, plus a cash deposit that brings the
 * register's lending value to `collateralMinor` — so a test written before
 * the register (UAE M3) keeps the collateral cover it was designed with.
 */
import type { TenantCode } from '../../config/loader.ts';
import { loadSecurityPolicy } from '../../config/loader.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { lendingValue } from '../../core/origination/security-register.ts';
import {
  confirmSecurityItem,
  recordCollateral,
  recordGuarantee,
  securityStatus,
} from '../../apps/ops/src/server/business.ts';

export async function meetSecurityRequirements(
  tenant: TenantCode,
  applicationId: string,
  officer: string,
  checker: string,
  collateralMinor: bigint,
  valuedAtEpochSeconds: bigint,
): Promise<void> {
  const policy = expectOk(loadSecurityPolicy(tenant));
  const status = expectOk(await securityStatus(tenant, applicationId));
  let lent = 0n;
  const collateral = async (kind: string, value: bigint) => {
    const v = expectOk(
      await recordCollateral(
        tenant,
        applicationId,
        {
          kind,
          description: `test ${kind.toLowerCase()}`,
          marketValueMinorUnits: value,
          valuedAtEpochSeconds,
          valuerRef: 'valuer-test',
          charge: 'NOT_APPLICABLE',
        },
        officer,
      ),
    );
    const item = v.security.collateral.at(-1);
    if (item === undefined) throw new Error('collateral not recorded');
    lent += lendingValue(item, policy).minorUnits;
    expectOk(await confirmSecurityItem(tenant, applicationId, item.itemId, checker));
  };
  for (const req of status.position.requirements) {
    const rule = policy.requirements[req.code];
    if (rule?.kind === 'GUARANTEE_FROM_EACH_OWNER') {
      for (const ref of req.missingOwners) {
        const g = expectOk(
          await recordGuarantee(tenant, applicationId, { guarantorKind: 'PERSONAL', guarantorRef: ref, guarantorName: '' }, officer),
        );
        const made = g.security.guarantees.at(-1);
        if (made === undefined) throw new Error('guarantee not recorded');
        expectOk(await confirmSecurityItem(tenant, applicationId, made.guaranteeId, checker));
      }
    } else if (rule?.kind === 'COLLATERAL') {
      await collateral(rule.collateralKind, rule.collateralKind === 'FINANCED_ASSET' ? collateralMinor : 1_000_00n);
    }
  }
  if (collateralMinor > lent) await collateral('CASH_DEPOSIT', collateralMinor - lent);
}
