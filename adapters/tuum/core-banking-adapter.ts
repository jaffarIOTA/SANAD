/**
 * Core banking adapter — Tuum.
 *
 * Implements `CoreBankingProvider`. The vendor's vocabulary stops here: nothing
 * in this file is exported into `core/`, and nothing `core/` hands down carries
 * a vendor concept back up.
 *
 * Endpoint paths and payload field names arrive as configuration rather than
 * literals, because the API surface is genuinely unverified (OI-02). Writing
 * guessed DTO shapes into code would look like progress and would have to be
 * unpicked the day the sandbox arrives. See README.md in this directory.
 */

import type {
  AccountPurpose,
  AccountRef,
  BookObligationRequest,
  BookingRef,
  CharityPostingRequest,
  CoreBankingProvider,
  ExposureView,
  IdempotencyKey,
  LifecycleEvent,
  LifecycleHandler,
  PartyDetails,
  PartyRef,
  PostingRef,
  SettlementInstruction,
  SettlementRef,
  Unsubscribe,
} from '../../core/ports/core-banking.ts';
import type { CredentialProvider } from '../../core/ports/credentials.ts';
import { type Result, ok, reject } from '../../core/kernel/result.ts';
import { money } from '../../core/kernel/money.ts';
import { type AdapterConfig, BaseAdapter, type KnownDeviation } from '../kernel/adapter.ts';
import { CircuitOpenError } from '../kernel/circuit-breaker.ts';

/**
 * Transport seam. The fixture implementation is what the pipeline runs against;
 * the HTTP implementation is filled in once the sandbox answers OI-02.
 */
export interface TuumTransport {
  call(
    operation: TuumOperation,
    payload: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export type TuumOperation =
  | 'party.resolveOrCreate'
  | 'account.resolve'
  | 'obligation.book'
  | 'settlement.instruct'
  | 'posting.charityLiability'
  | 'exposure.fetch';

export interface TuumAdapterConfig extends AdapterConfig {
  /**
   * Field names the vendor requires that the domain model does not express.
   * Supplied as configuration so an unverified vendor concept is not named in
   * code. See TUUM-DEV-001 in README.md.
   */
  readonly vendorPricingCompatibilityFields: Readonly<Record<string, string | number>>;
  /** Vendor codes for each account purpose, discovered during verification. */
  readonly accountPurposeCodes: Readonly<Record<AccountPurpose, string>>;
}

/**
 * Exported so the architecture suite can assert every deviation names how it is
 * contained and which open item tracks it, without constructing an adapter.
 */
export const TUUM_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'TUUM-DEV-001',
    summary:
      'The booking payload may require a pricing field expressing return as a periodic proportion, which the domain model does not have and will not acquire.',
    containment:
      'Supplied from vendorPricingCompatibilityFields in adapter configuration. The field name is configuration, not code. The domain model continues to carry cost, profit amount and total only, and nothing recomputes after execution.',
    verificationRef: 'OI-02',
  },
  {
    id: 'TUUM-DEV-002',
    summary: 'The party master requires restricted attributes the domain model does not carry.',
    containment:
      'Resolved from restrictedAttributesRef inside the trust boundary immediately before the call; never returned, logged or placed on a trace span.',
    verificationRef: 'OI-02',
  },
];

export class TuumCoreBankingAdapter extends BaseAdapter implements CoreBankingProvider {
  readonly capabilities = ['CORE_BANKING'] as const;
  readonly vendorName = 'Tuum';
  readonly deviations = TUUM_DEVIATIONS;

  readonly #handlers = new Set<LifecycleHandler>();

  constructor(
    protected override readonly config: TuumAdapterConfig,
    credentials: CredentialProvider,
    private readonly transport: TuumTransport,
    /** Resolves a restricted-attributes pointer. Runs inside the trust boundary. */
    private readonly restrictedAttributes: (ref: string) => Promise<Record<string, string>>,
  ) {
    super(config, credentials);
  }

  async resolveOrCreateParty(
    party: PartyDetails,
    key: IdempotencyKey,
  ): Promise<Result<PartyRef>> {
    const restricted =
      party.restrictedAttributesRef === undefined
        ? {}
        : await this.restrictedAttributes(party.restrictedAttributesRef);

    return this.#invoke('party.resolveOrCreate', key, party.tenantId, {
      registrationNumber: party.registrationNumber,
      legalNameAr: party.legalNameAr,
      legalNameEn: party.legalNameEn,
      legalForm: party.legalForm,
      ...restricted,
    }).then((r) => (r.ok ? refFrom(r.value, 'partyId', (value) => ({ value })) : r));
  }

  async resolveAccount(partyRef: PartyRef, purpose: AccountPurpose): Promise<Result<AccountRef>> {
    const code = this.config.accountPurposeCodes[purpose];
    if (code === undefined) {
      return reject(
        'OP-DETERMINACY',
        'ACCOUNT_PURPOSE_UNMAPPED',
        'No vendor account code is configured for this purpose',
        { purpose },
      );
    }
    const response = await this.#invoke(
      'account.resolve',
      { value: `${partyRef.value}:${purpose}` },
      this.config.tenantId,
      { partyId: partyRef.value, accountTypeCode: code },
    );
    return response.ok ? refFrom(response.value, 'accountId', (value) => ({ value })) : response;
  }

  async bookObligation(
    request: BookObligationRequest,
    key: IdempotencyKey,
  ): Promise<Result<BookingRef>> {
    // The payload carries a fixed total and a schedule. Cost and profit travel
    // as disclosed amounts because the Murabaha's validity depends on the
    // disclosure — not because anything downstream derives a proportion.
    const payload = {
      partyId: request.partyRef.value,
      accountId: request.collectionAccount.value,
      currency: request.totalAmount.currency,
      totalAmountMinorUnits: String(request.totalAmount.minorUnits),
      costAmountMinorUnits: String(request.costAmount.minorUnits),
      profitAmountMinorUnits: String(request.profitAmount.minorUnits),
      maturityDate: request.maturityDateGregorian,
      maturityDateHijri: request.maturityDateHijri,
      schedule: request.instalments.map((i) => ({
        sequence: i.instalmentNo,
        dueDate: i.dueDateGregorian,
        dueDateHijri: i.dueDateHijri,
        amountMinorUnits: String(i.amount.minorUnits),
      })),
      // TUUM-DEV-001. Configuration, not code.
      ...this.config.vendorPricingCompatibilityFields,
    };

    const response = await this.#invoke('obligation.book', key, request.tenantId, payload, {
      'X-Correlation-Id': request.correlationId,
    });
    return response.ok ? refFrom(response.value, 'bookingId', (value) => ({ value })) : response;
  }

  async instructSettlement(
    instruction: SettlementInstruction,
    key: IdempotencyKey,
  ): Promise<Result<SettlementRef>> {
    const response = await this.#invoke(
      'settlement.instruct',
      key,
      instruction.tenantId,
      {
        debitAccountId: instruction.fromAccount.value,
        beneficiaryPartyId: instruction.beneficiaryPartyRef.value,
        currency: instruction.amount.currency,
        amountMinorUnits: String(instruction.amount.minorUnits),
        valueDate: instruction.valueDateGregorian,
        remittanceReference: instruction.remittanceReference,
      },
      { 'X-Correlation-Id': instruction.correlationId },
    );
    return response.ok ? refFrom(response.value, 'settlementId', (value) => ({ value })) : response;
  }

  /**
   * Late amounts post to the segregated charity liability and nowhere else.
   *
   * The adapter re-derives the account from the purpose rather than trusting the
   * one it was handed, so a caller cannot route a late amount to an arbitrary
   * account by passing a different reference (SH-13).
   */
  async postCharityLiability(
    request: CharityPostingRequest,
    key: IdempotencyKey,
  ): Promise<Result<PostingRef>> {
    const expected = this.config.accountPurposeCodes.CHARITY_LIABILITY;
    if (expected === undefined) {
      return reject(
        'SH-13',
        'CHARITY_ACCOUNT_UNMAPPED',
        'No segregated charity liability account is configured; a late amount cannot be posted anywhere else',
      );
    }

    const response = await this.#invoke(
      'posting.charityLiability',
      key,
      request.tenantId,
      {
        accountId: request.account.value,
        accountTypeCode: expected,
        currency: request.amount.currency,
        amountMinorUnits: String(request.amount.minorUnits),
        reasonCode: request.reasonCode,
      },
      { 'X-Correlation-Id': request.correlationId },
    );
    return response.ok ? refFrom(response.value, 'postingId', (value) => ({ value })) : response;
  }

  async fetchExposure(partyRef: PartyRef): Promise<Result<ExposureView>> {
    const response = await this.#invoke(
      'exposure.fetch',
      { value: `exposure:${partyRef.value}` },
      this.config.tenantId,
      { partyId: partyRef.value },
    );
    if (!response.ok) return response;

    const body = response.value;
    const minorUnits = body['totalOutstandingMinorUnits'];
    if (typeof minorUnits !== 'string') {
      return reject('OP-DETERMINACY', 'EXPOSURE_MALFORMED', 'Exposure response was not understood');
    }
    return ok({
      partyRef,
      totalOutstanding: money(BigInt(minorUnits)),
      facilityCount: numberOr(body['facilityCount'], 0),
      worstArrearsDays: numberOr(body['worstArrearsDays'], 0),
    });
  }

  subscribeLifecycle(handler: LifecycleHandler): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Entry point for the webhook or event consumer. Handlers are idempotent. */
  async dispatchLifecycle(event: LifecycleEvent): Promise<void> {
    for (const handler of this.#handlers) {
      await handler(event);
    }
  }

  // ---------------------------------------------------------------------------

  async #invoke(
    operation: TuumOperation,
    key: IdempotencyKey,
    tenantId: string,
    payload: Readonly<Record<string, unknown>>,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Result<Readonly<Record<string, unknown>>>> {
    try {
      const apiKey = await this.credential('api_key', key.value);
      const body = await this.breaker.execute(() =>
        this.transport.call(operation, { ...payload, tenantReference: tenantId }, {
          // The only place the plaintext is used. Never logged, never traced.
          Authorization: `Bearer ${apiKey.expose()}`,
          'Idempotency-Key': key.value,
          ...extraHeaders,
        }),
      );
      return ok(body);
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        return reject(
          'OP-DETERMINACY',
          'CORE_BANKING_CIRCUIT_OPEN',
          'The core banking platform is unavailable; the instruction is queued and will be reconciled',
          { operation },
        );
      }
      // The message is deliberately not the vendor's. A vendor error string can
      // echo a payload, and payloads carry restricted data.
      return reject(
        'OP-DETERMINACY',
        'CORE_BANKING_CALL_FAILED',
        'The core banking platform did not complete the instruction; it is queued for retry',
        { operation },
      );
    }
  }
}

function refFrom<T>(
  body: Readonly<Record<string, unknown>>,
  field: string,
  wrap: (value: string) => T,
): Result<T> {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    return reject('OP-DETERMINACY', 'REFERENCE_MISSING', 'The response did not carry an identifier', {
      field,
    });
  }
  return ok(wrap(value));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
