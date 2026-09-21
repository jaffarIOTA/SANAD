import bankAStructure from "./tenants/bank-a/structures/murabaha-distributor.json" with { type: "json" };
import fintechBStructure from "./tenants/fintech-b/structures/murabaha-distributor.json" with { type: "json" };
import bankAPolicyV1 from "./tenants/bank-a/credit-policy/wasl-distributor-v1.json" with { type: "json" };
import fintechBPolicyV1 from "./tenants/fintech-b/credit-policy/wasl-distributor-v1.json" with { type: "json" };
import {
  parseStructureDefinition
} from "../core/structures/definition.js";
import { parseCreditPolicy } from "../core/decisioning/policy.js";
import { ok, reject } from "../core/kernel/result.js";
const TENANT_CODES = ["bank-a", "fintech-b"];
const STRUCTURES = {
  "bank-a": [bankAStructure],
  "fintech-b": [fintechBStructure]
};
const CREDIT_POLICIES = {
  "bank-a": [bankAPolicyV1],
  "fintech-b": [fintechBPolicyV1]
};
function isTenantCode(value) {
  return TENANT_CODES.includes(value);
}
function loadStructureDefinition(tenant, definitionId) {
  for (const candidate of STRUCTURES[tenant]) {
    const parsed = parseStructureDefinition(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.definitionId === definitionId) return parsed;
  }
  return reject(
    "SH-17",
    "STRUCTURE_DEFINITION_NOT_FOUND",
    "No approved structure definition of that identifier is configured for this tenant",
    { tenant, definitionId }
  );
}
function loadCreditPolicyVersions(tenant, policyId) {
  const versions = [];
  for (const candidate of CREDIT_POLICIES[tenant]) {
    const parsed = parseCreditPolicy(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.policyId === policyId) versions.push(parsed.value);
  }
  if (versions.length === 0) {
    return reject(
      "OP-DETERMINACY",
      "CREDIT_POLICY_NOT_FOUND",
      "No credit policy of that identifier is configured for this tenant",
      { tenant, policyId }
    );
  }
  return ok(versions);
}
function loadAllForTenant(tenant) {
  const structures = [];
  for (const candidate of STRUCTURES[tenant]) {
    const parsed = parseStructureDefinition(candidate);
    if (!parsed.ok) return parsed;
    structures.push(parsed.value);
  }
  const creditPolicies = [];
  for (const candidate of CREDIT_POLICIES[tenant]) {
    const parsed = parseCreditPolicy(candidate);
    if (!parsed.ok) return parsed;
    creditPolicies.push(parsed.value);
  }
  return ok({ structures, creditPolicies });
}
export {
  TENANT_CODES,
  isTenantCode,
  loadAllForTenant,
  loadCreditPolicyVersions,
  loadStructureDefinition
};
