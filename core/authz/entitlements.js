import { ok, reject } from "../kernel/result.js";
const ENTITLEMENT_ACTIONS = [
  // Programme and configuration
  "programme.read",
  "programme.draft",
  "programme.submit_for_shariah_approval",
  "programme.activate",
  // guarded on an in-force approval, not on a role
  "programme.suspend",
  // Counterparty
  "counterparty.read",
  "counterparty.invite",
  "counterparty.resolve_verification_exception",
  "counterparty.suspend",
  // Decisioning and limits
  "decision.read",
  "decision.request_recompute",
  "limit.read",
  "limit.propose_change",
  "limit.approve_change",
  // four-eyes; the proposer cannot approve
  "limit.suspend",
  // Transaction and evidence
  "transaction.read",
  "transaction.initiate",
  "evidence.upload",
  "evidence.resolve_extraction_exception",
  "evidence.mark_invalid",
  // supersedes; never deletes
  "transaction.request_unwind",
  "transaction.approve_unwind",
  // Documents
  "document.read",
  "document.regenerate_failed",
  "document.resolve_drift_exception",
  // Settlement
  "settlement.read",
  "settlement.retry_failed",
  "settlement.resolve_return",
  // Lifecycle
  "hardship.open",
  "hardship.assess",
  "reschedule.propose",
  "reschedule.approve",
  // Shariah governance — read-only by construction for audit
  "shariah.audit.read",
  "shariah.audit.export",
  "shariah.audit.raise_observation",
  "shariah.incident.triage",
  "shariah.incident.close",
  "shariah.approval.record",
  "purification.compute",
  "purification.disburse",
  // Administration
  "admin.user.manage",
  "admin.entitlement.assign",
  "admin.configuration.propose",
  "admin.configuration.approve"
];
const CATALOGUE = new Set(ENTITLEMENT_ACTIONS);
const SEQUENCING_TRANSITIONS = [
  "acquireOwnership",
  "confirmPossession",
  "offerSale",
  "acceptOffer"
];
const FORBIDDEN_ENTITLEMENT_PATTERNS = [
  /\boverride\b/i,
  /\bbypass\b/i,
  /\bforce\b/i,
  /\bskip[_.]?gate/i,
  /gate[_.]?(advance|satisfy|waive|override)/i,
  /\bwaive[_.]?risk/i,
  /\bsuperuser\b/i,
  /\bimpersonat/i
];
function defineEntitlement(spec) {
  const unknown = spec.actions.filter((a) => !CATALOGUE.has(a));
  if (unknown.length > 0) {
    return reject(
      "SH-05",
      "UNKNOWN_ENTITLEMENT_ACTION",
      "Entitlements may only grant actions from the closed catalogue",
      { roleCode: spec.roleCode, unknown: unknown.join(",") }
    );
  }
  for (const action of spec.actions) {
    for (const pattern of FORBIDDEN_ENTITLEMENT_PATTERNS) {
      if (pattern.test(action)) {
        return reject(
          "SH-05",
          "BYPASS_SHAPED_ENTITLEMENT",
          "No entitlement may be capable of advancing a transaction past an unsatisfied gate",
          { roleCode: spec.roleCode, action }
        );
      }
    }
    if (SEQUENCING_TRANSITIONS.includes(action)) {
      return reject(
        "SH-05",
        "ENTITLEMENT_NAMES_A_SEQUENCING_TRANSITION",
        "Sequencing transitions are not entitlement-guarded operations; they are state machine edges",
        { roleCode: spec.roleCode, action }
      );
    }
  }
  return ok({
    entitlementId: spec.entitlementId,
    tenantId: spec.tenantId,
    roleCode: spec.roleCode,
    actions: spec.actions,
    scope: spec.scope,
    requiresFourEyes: spec.requiresFourEyes ?? false
  });
}
function permits(entitlement, action) {
  return entitlement.actions.includes(action);
}
export {
  ENTITLEMENT_ACTIONS,
  FORBIDDEN_ENTITLEMENT_PATTERNS,
  SEQUENCING_TRANSITIONS,
  defineEntitlement,
  permits
};
