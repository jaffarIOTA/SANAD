/**
 * Shariah approvals for the suites (W6a): no approval in force, no new
 * origination on an Islamic product (SH-17). Each approval a tenant's board
 * positions and catalogue cite is recorded by one Shariah reviewer and
 * confirmed by another, exactly as the workbench does — so a suite about
 * sequencing, settlement or a Tawarruq starts from a product that may originate.
 */
import { type TenantCode, loadBoardPositions, loadProductCatalogue } from '@sanad/config/loader.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { ISLAMIC_PRODUCT_CODES } from '@sanad/core/products/registry.ts';

import {
  approvalChanges,
  decideApprovalChange,
  proposeApprovalChange,
  shariahRegister,
} from '../../services/origination/src/shariah/approvals.ts';

/** Record one approval, in force from long ago with no expiry, unless the register already holds it. */
export async function recordTestApproval(
  tenant: TenantCode,
  approvalRef: string,
  productCodes: readonly string[],
  templateVersionIds: readonly string[] = [],
): Promise<void> {
  if ((await shariahRegister(tenant)).some((a) => a.approvalRef === approvalRef)) return;
  const proposed = await proposeApprovalChange(tenant, 'stf-shariah-test-1', {
    change: {
      kind: 'RECORD',
      terms: {
        approvalRef,
        approvingBody: 'Shariah board (test)',
        members: ['Test member one', 'Test member two'],
        effectiveFrom: '2020-01-01',
        productCodes,
        templateVersionIds,
      },
    },
    reason: 'Recorded for the test suites',
  });
  // Another suite on the same database may have proposed it a moment ago: confirm that one instead.
  const open = proposed.ok
    ? proposed.value
    : (await approvalChanges(tenant)).find(
        (e) => e.state === 'PROPOSED' && e.change.kind === 'RECORD' && e.change.terms.approvalRef === approvalRef,
      );
  if (open !== undefined)
    await decideApprovalChange(tenant, 'stf-shariah-test-2', { changeId: open.changeId, confirm: true, note: '' });
  if (!(await shariahRegister(tenant)).some((a) => a.approvalRef === approvalRef))
    throw new Error(`approval ${approvalRef} was not recorded for ${tenant}`);
}

/** Every approval the tenant's board positions and catalogue cite, each covering the products that cite it. */
export async function recordTestApprovals(tenant: TenantCode = 'bank-a'): Promise<void> {
  const products = new Map<string, Set<string>>();
  const templates = new Map<string, readonly string[]>();
  const catalogue = expectOk(loadProductCatalogue(tenant));
  for (const e of catalogue.entries)
    if (ISLAMIC_PRODUCT_CODES.has(e.productCode) && e.boardRulingRef !== undefined)
      products.set(e.boardRulingRef, (products.get(e.boardRulingRef) ?? new Set()).add(e.productCode));
  const board = loadBoardPositions(tenant);
  if (board.ok) {
    const ref = board.value.shariahApprovalRef;
    products.set(ref, (products.get(ref) ?? new Set()).add('murabaha-scf'));
    templates.set(
      ref,
      board.value.approvedTemplates.map((t) => t.templateVersionId),
    );
  }
  for (const [ref, codes] of products) await recordTestApproval(tenant, ref, [...codes], templates.get(ref) ?? []);
}
