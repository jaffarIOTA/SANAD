import { ok, reject } from "../kernel/result.js";
const ORIGINATION_CHANNELS = [
  "MAKER_CHECKER",
  "COUNTERPARTY_SELF",
  "PARTNER_API",
  "EMBEDDED_AGGREGATOR"
];
const CHANNEL_POLICIES = {
  MAKER_CHECKER: {
    channel: "MAKER_CHECKER",
    requiresServicingDecision: false,
    requiresFourEyes: true,
    acceptableIdentification: ["STAFF_PRINCIPAL"],
    requiresMerchantMandate: false
  },
  COUNTERPARTY_SELF: {
    channel: "COUNTERPARTY_SELF",
    requiresServicingDecision: false,
    requiresFourEyes: false,
    acceptableIdentification: ["VERIFIED_SIGNATORY"],
    requiresMerchantMandate: false
  },
  PARTNER_API: {
    channel: "PARTNER_API",
    // An external system asked. The institution's own platform answers before
    // anyone signs anything off.
    requiresServicingDecision: true,
    requiresFourEyes: false,
    acceptableIdentification: ["PARTNER_SYSTEM"],
    requiresMerchantMandate: false
  },
  EMBEDDED_AGGREGATOR: {
    channel: "EMBEDDED_AGGREGATOR",
    requiresServicingDecision: true,
    // Someone who is not the borrower is asking for credit in the borrower's
    // name. A second pair of eyes is the least of it.
    requiresFourEyes: true,
    acceptableIdentification: ["AGGREGATOR_ON_BEHALF"],
    requiresMerchantMandate: true
  }
};
function verifyIdentification(channel, identification) {
  const policy = CHANNEL_POLICIES[channel];
  if (!policy.acceptableIdentification.includes(identification.kind)) {
    return reject(
      "OP-DETERMINACY",
      "IDENTIFICATION_NOT_ACCEPTABLE_FOR_CHANNEL",
      "The initiator was not identified in a way this channel accepts",
      { channel, presented: identification.kind }
    );
  }
  if (policy.requiresMerchantMandate) {
    if (identification.kind !== "AGGREGATOR_ON_BEHALF") {
      return reject(
        "OP-DETERMINACY",
        "MERCHANT_MANDATE_MISSING",
        "This channel requires a mandate from the party who will owe the money",
        { channel }
      );
    }
    if (identification.merchantMandateRef.trim().length === 0) {
      return reject(
        "OP-DETERMINACY",
        "MERCHANT_MANDATE_EMPTY",
        "An aggregator may introduce a merchant; it may not consent on the merchant\u2019s behalf",
        { channel, aggregatorId: identification.aggregatorId }
      );
    }
  }
  return ok(true);
}
export {
  CHANNEL_POLICIES,
  ORIGINATION_CHANNELS,
  verifyIdentification
};
