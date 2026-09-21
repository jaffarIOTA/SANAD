import { ok, reject } from "../../core/kernel/result.js";
import { money } from "../../core/kernel/money.js";
import { BaseAdapter } from "../kernel/adapter.js";
import { CircuitOpenError } from "../kernel/circuit-breaker.js";
const TUUM_DEVIATIONS = [
  {
    id: "TUUM-DEV-002",
    summary: "The party master requires restricted attributes the domain model does not carry.",
    containment: "Resolved from restrictedAttributesRef inside the trust boundary immediately before the call; never returned, logged or placed on a trace span.",
    verificationRef: "OI-02"
  },
  {
    id: "TUUM-DEV-003",
    summary: "Postings are single-sided: one account in the path, direction carried by a tenant-defined transaction type code. The domain thinks in obligations, not in postings.",
    containment: "The adapter owns the mapping from an obligation to its postings, and the codes are configuration rather than literals. No posting concept crosses upward into the domain model.",
    verificationRef: "OI-02"
  },
  {
    id: "TUUM-DEV-004",
    summary: "The platform has a lending module that derives and persists a periodic proportion, and a top-up path that increases a booked principal.",
    containment: "Not used, and not usable: this adapter exposes no lending operation, the constructor refuses a configuration pointing at the lending module, and an architecture test asserts the source carries no lending path. Residual risk is the vendor back office, which is outside this boundary \u2014 mitigated by entitlement configuration and by the reconciliation check described in README.md, Finding 2.",
    verificationRef: "OI-02"
  }
];
const LENDING_HOST = /(^|[./-])loan(s)?[-.]/i;
class TuumCoreBankingAdapter extends BaseAdapter {
  constructor(config, credentials, transport, restrictedAttributes) {
    super(config, credentials);
    this.config = config;
    this.transport = transport;
    this.restrictedAttributes = restrictedAttributes;
    for (const [name, host] of Object.entries(config.hosts)) {
      if (LENDING_HOST.test(host)) {
        throw new Error(
          `core banking adapter configured with a lending host (${name}=${host}); the obligation, its schedule and its profit amount are held in this platform, not in the vendor lending module. See adapters/tuum/README.md, Finding 1.`
        );
      }
    }
  }
  capabilities = ["CORE_BANKING"];
  vendorName = "Tuum";
  deviations = TUUM_DEVIATIONS;
  #handlers = /* @__PURE__ */ new Set();
  // -- Parties ----------------------------------------------------------------
  async resolveOrCreateParty(party, key) {
    const restricted = party.restrictedAttributesRef === void 0 ? {} : await this.restrictedAttributes(party.restrictedAttributesRef);
    const response = await this.#invoke(
      "person.resolveOrCreate",
      "POST",
      `${this.config.hosts.person}/api/v1/persons`,
      key,
      {
        registrationNumber: party.registrationNumber,
        legalNameAr: party.legalNameAr,
        legalNameEn: party.legalNameEn,
        legalForm: party.legalForm,
        ...restricted
      }
    );
    return response.ok ? identifier(response.value, "personId") : response;
  }
  // -- Accounts ---------------------------------------------------------------
  async resolveAccount(partyRef, purpose) {
    const institutionAccount = this.config.institutionAccounts[purpose];
    if (institutionAccount !== void 0) return ok({ value: institutionAccount });
    const typeCode = this.config.accountPurposeCodes[purpose];
    if (typeCode === void 0) {
      return reject(
        "OP-DETERMINACY",
        "ACCOUNT_PURPOSE_UNMAPPED",
        "No account type is configured for this purpose",
        { purpose }
      );
    }
    const found = await this.#invoke(
      "account.findByPurpose",
      "GET",
      `${this.config.hosts.account}/api/v5/persons/${partyRef.value}/accounts?accountTypeCode=${encodeURIComponent(typeCode)}`,
      { value: `find:${partyRef.value}:${purpose}` }
    );
    if (!found.ok) return found;
    const existing = firstAccountId(found.value);
    if (existing !== void 0) return ok({ value: existing });
    const created = await this.#invoke(
      "account.create",
      "POST",
      `${this.config.hosts.account}/api/v4/persons/${partyRef.value}/accounts`,
      { value: `create:${partyRef.value}:${purpose}` },
      { accountTypeCode: typeCode }
    );
    return created.ok ? identifier(created.value, "accountId") : created;
  }
  // -- The sale ---------------------------------------------------------------
  /**
   * Record the executed sale in the ledger.
   *
   * What goes downstream: the receivable on the counterparty, at the total that
   * was agreed. What does not: the schedule, the tenor, and any notion of how
   * the total was arrived at. There is nothing here for the platform to
   * recompute, which is the entire point of the split.
   *
   * Cost and profit travel as detail because the institution's accounting needs
   * them separately — goods leave inventory at cost. How the mapping treats
   * deferred profit is a question for the client's finance function under its
   * AAOIFI-aligned chart of accounts, not one this adapter should answer.
   */
  async bookObligation(request, key) {
    if (request.totalAmount.minorUnits !== request.costAmount.minorUnits + request.profitAmount.minorUnits) {
      return reject(
        "SH-01",
        "TOTAL_IS_NOT_COST_PLUS_PROFIT",
        "Refusing to book an obligation whose total is not the sum of its cost and profit",
        { transactionId: request.transactionId }
      );
    }
    const response = await this.#invoke(
      "account.postTransaction",
      "POST",
      `${this.config.hosts.account}/api/v5/accounts/${request.collectionAccount.value}/transactions`,
      key,
      {
        transactionTypeCode: this.config.transactionTypeCodes.murabahaReceivableRaise,
        money: {
          amount: String(request.totalAmount.minorUnits),
          currencyCode: request.totalAmount.currency
        },
        // Carried for reconciliation, which asserts the booked total still
        // equals cost plus profit (README.md, Finding 2).
        externalReference: request.transactionId,
        details: {
          costMinorUnits: String(request.costAmount.minorUnits),
          profitMinorUnits: String(request.profitAmount.minorUnits),
          maturityDate: request.maturityDateGregorian,
          maturityDateHijri: request.maturityDateHijri
        }
      },
      request.correlationId
    );
    return response.ok ? identifier(response.value, "transactionId") : response;
  }
  // -- Money movement ---------------------------------------------------------
  async instructSettlement(instruction, key) {
    const response = await this.#invoke(
      "payment.instruct",
      "POST",
      `${this.config.hosts.payment}/api/v1/payments`,
      key,
      {
        debitAccountId: instruction.fromAccount.value,
        beneficiaryPersonId: instruction.beneficiaryPartyRef.value,
        money: {
          amount: String(instruction.amount.minorUnits),
          currencyCode: instruction.amount.currency
        },
        valueDate: instruction.valueDateGregorian,
        remittanceInformation: instruction.remittanceReference,
        externalReference: instruction.transactionId
      },
      instruction.correlationId
    );
    return response.ok ? identifier(response.value, "paymentId") : response;
  }
  /**
   * Late amounts post to the segregated charity liability and nowhere else.
   *
   * The account and the posting code are both re-derived from configuration
   * rather than taken from the caller, so passing a different account reference
   * cannot route a late amount somewhere it must not go (SH-13).
   */
  async postCharityLiability(request, key) {
    const account = this.config.institutionAccounts.CHARITY_LIABILITY;
    if (account === void 0) {
      return reject(
        "SH-13",
        "CHARITY_ACCOUNT_UNMAPPED",
        "No segregated charity liability account is configured; a late amount cannot be posted anywhere else"
      );
    }
    const response = await this.#invoke(
      "account.postTransaction",
      "POST",
      `${this.config.hosts.account}/api/v5/accounts/${account}/transactions`,
      key,
      {
        transactionTypeCode: this.config.transactionTypeCodes.charityLiabilityRaise,
        money: {
          amount: String(request.amount.minorUnits),
          currencyCode: request.amount.currency
        },
        externalReference: request.transactionId,
        details: { reasonCode: request.reasonCode }
      },
      request.correlationId
    );
    return response.ok ? identifier(response.value, "transactionId") : response;
  }
  // -- Exposure ---------------------------------------------------------------
  async fetchExposure(partyRef) {
    const response = await this.#invoke(
      "account.balance",
      "GET",
      `${this.config.hosts.account}/api/v5/persons/${partyRef.value}/accounts`,
      { value: `exposure:${partyRef.value}` }
    );
    if (!response.ok) return response;
    const outstanding = sumBalances(response.value);
    if (outstanding === void 0) {
      return reject("OP-DETERMINACY", "EXPOSURE_MALFORMED", "Balances were not understood");
    }
    return ok({
      partyRef,
      totalOutstanding: money(outstanding.minorUnits),
      facilityCount: outstanding.accountCount,
      // Arrears are tracked here, against our own schedule, not downstream.
      worstArrearsDays: 0
    });
  }
  subscribeLifecycle(handler) {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  /** Entry point for the webhook consumer. Handlers are idempotent. */
  async dispatchLifecycle(event) {
    for (const handler of this.#handlers) await handler(event);
  }
  // ---------------------------------------------------------------------------
  async #invoke(operation, method, url, key, body, correlationId) {
    try {
      const token = await this.credential("api_token", correlationId ?? key.value);
      const response = await this.breaker.execute(
        () => this.transport.call(operation, {
          method,
          url,
          ...body === void 0 ? {} : { body },
          headers: {
            // The one place the plaintext is used. Never logged, never traced.
            "x-auth-token": token.expose(),
            "x-channel-code": this.config.channelCode,
            // Verified: the platform's idempotency key. Reusing one replays the
            // original response rather than creating a second object.
            "x-request-id": key.value,
            ...correlationId === void 0 ? {} : { "x-correlation-id": correlationId },
            ...method === "POST" ? { "Content-Type": "application/json" } : {}
          }
        })
      );
      return ok(response);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return reject(
          "OP-DETERMINACY",
          "CORE_BANKING_CIRCUIT_OPEN",
          "The core banking platform is unavailable; the instruction is queued and will be reconciled",
          { operation }
        );
      }
      return reject(
        "OP-DETERMINACY",
        "CORE_BANKING_CALL_FAILED",
        "The core banking platform did not complete the instruction; it is queued for retry",
        { operation }
      );
    }
  }
}
function identifier(body, field) {
  const direct = body[field];
  const nested = body["data"]?.[field];
  const value = typeof direct === "string" ? direct : nested;
  if (typeof value !== "string" || value.length === 0) {
    return reject("OP-DETERMINACY", "REFERENCE_MISSING", "The response carried no identifier", {
      field
    });
  }
  return ok({ value });
}
function rows(body) {
  const payload = Array.isArray(body["data"]) ? body["data"] : body["accounts"];
  return Array.isArray(payload) ? payload.filter((r) => typeof r === "object" && r !== null) : [];
}
function firstAccountId(body) {
  for (const row of rows(body)) {
    const id = row["accountId"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return void 0;
}
function sumBalances(body) {
  const all = rows(body);
  if (all.length === 0) return { minorUnits: 0n, accountCount: 0 };
  let total = 0n;
  for (const row of all) {
    const balance = row["balanceMinorUnits"] ?? row["balanceAmountMinorUnits"];
    if (typeof balance === "string") {
      try {
        total += BigInt(balance);
      } catch {
        return void 0;
      }
    } else if (typeof balance === "bigint") {
      total += balance;
    }
  }
  return { minorUnits: total, accountCount: all.length };
}
export {
  TUUM_DEVIATIONS,
  TuumCoreBankingAdapter
};
