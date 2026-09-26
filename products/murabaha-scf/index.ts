/**
 * The Murabaha SCF module as the engine sees it.
 *
 * Trade-first: a quote needs a real trade and a cost. The profit amount comes
 * in from the engine's quotation (the tenant's rule, applied outside this
 * directory); here it is an amount and only an amount. The schedule is the
 * sale price, payable at maturity or in equal instalments. Execution opens a
 * transaction in DRAFT and nothing later.
 */

import type { Approved } from '@sanad/core/origination/request.ts';
import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Disclosure, ProductModule, Quote, QuoteRequest } from '@sanad/core/products/module.ts';

import { openTransaction } from './origination/open-transaction.ts';
import { type MurabahaPricing, priceMurabaha } from './pricing/murabaha.ts';
import type { Draft, TransactionCore } from './sequencing/state.ts';
import type { StructureCode, StructureDefinition } from './structures/definition.ts';

export interface MurabahaTerms {
  readonly instalments: 'BULLET' | { readonly count: number };
  readonly structureCode: StructureCode;
  readonly maxTenorDays: number;
}

export interface MurabahaQuote extends Quote {
  readonly productCode: 'murabaha-scf';
  readonly pricing: MurabahaPricing;
}

/** What the host must supply to open the transaction: the board's structure and the calendar facts. */
export interface MurabahaExecutionContext {
  readonly transactionId: string;
  readonly structure: StructureDefinition;
  readonly riskPeriodRequiredSeconds: number;
  readonly maturityDateGregorian: string;
  readonly maturityDateHijri: string;
  readonly decisionId: string;
  readonly creditPolicyVersion: string;
  readonly correlationId: string;
}

const STRUCTURE_CODES: readonly StructureCode[] = ['MURABAHA', 'SALAM', 'ISTISNA', 'IJARAH', 'MUSHARAKA'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const murabahaScf: ProductModule<MurabahaTerms, MurabahaQuote, MurabahaExecutionContext, Draft> = {
  descriptor: {
    code: 'murabaha-scf',
    nameEn: 'Murabaha supply-chain finance',
    nameAr: 'تمويل سلاسل الإمداد بالمرابحة',
    journeyShape: 'TRADE_FIRST',
    family: 'ISLAMIC',
    consumer: false,
    requiresBoardRuling: true,
  },

  validateTerms(raw: unknown): Result<MurabahaTerms> {
    if (!isRecord(raw)) return reject('OP-DETERMINACY', 'TERMS_MALFORMED', 'Murabaha terms are an object');
    const unknown = Object.keys(raw).filter((k) => !['instalments', 'structureCode', 'maxTenorDays'].includes(k));
    if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in Murabaha terms', { keys: unknown.join(',') });
    const inst = raw['instalments'];
    const instalments: MurabahaTerms['instalments'] | undefined =
      inst === 'BULLET' ? 'BULLET' : isRecord(inst) && typeof inst['count'] === 'number' && Number.isInteger(inst['count']) && inst['count'] > 0 ? { count: inst['count'] } : undefined;
    if (instalments === undefined) return reject('OP-DETERMINACY', 'TERMS_INSTALMENTS', "instalments is 'BULLET' or { count }");
    if (!STRUCTURE_CODES.includes(raw['structureCode'] as StructureCode)) return reject('OP-DETERMINACY', 'TERMS_STRUCTURE', 'structureCode is one of the declared structures');
    if (typeof raw['maxTenorDays'] !== 'number' || !Number.isInteger(raw['maxTenorDays']) || raw['maxTenorDays'] <= 0) return reject('OP-DETERMINACY', 'TERMS_TENOR', 'maxTenorDays is a positive integer');
    return ok({ instalments, structureCode: raw['structureCode'] as StructureCode, maxTenorDays: raw['maxTenorDays'] });
  },

  quote(terms, request: QuoteRequest): Result<MurabahaQuote> {
    if (request.tradeReference === undefined) {
      return reject('SH-10', 'TRADE_REQUIRED', 'A Murabaha starts from a real trade, not an amount');
    }
    if (request.pricing.profitAmount === undefined) {
      return reject('SH-03', 'PROFIT_AMOUNT_REQUIRED', 'A Murabaha is priced by a profit amount');
    }
    if (request.requestedTenorDays > terms.maxTenorDays) {
      return reject('OP-DETERMINACY', 'TENOR_EXCEEDS_PRODUCT', 'Tenor exceeds what this product allows', { max: String(terms.maxTenorDays) });
    }
    const pricing = priceMurabaha(request.requestedAmount, request.pricing.profitAmount);
    if (!pricing.ok) return pricing;
    const p = pricing.value;
    const repayments = split(p.salePriceAmount, terms.instalments, request.requestedTenorDays);
    return ok({
      productCode: 'murabaha-scf',
      financingAmount: p.costAmount,
      tenorDays: request.requestedTenorDays,
      schedule: [{ at: { months: 0, days: 0 }, amount: p.costAmount, direction: 'DRAWDOWN' }, ...repayments],
      fees: [],
      totalPayable: p.salePriceAmount,
      totalCostOfCredit: p.profitAmount,
      pricing: p,
    });
  },

  disclose(quote): Disclosure {
    const repayments = quote.schedule.filter((f) => f.direction === 'REPAYMENT');
    const equal = repayments.every((f) => f.amount.minorUnits === repayments[0]?.amount.minorUnits);
    return {
      financingAmount: quote.financingAmount,
      tenorDays: quote.tenorDays,
      instalmentCount: repayments.length,
      ...(equal && repayments[0] !== undefined ? { instalmentAmount: repayments[0].amount } : {}),
      totalCostOfCredit: quote.totalCostOfCredit,
      totalPayable: quote.totalPayable,
      fees: quote.fees,
      lines: [
        { code: 'COST', labelEn: 'Cost of goods', labelAr: 'تكلفة البضاعة', amount: quote.pricing.costAmount },
        { code: 'PROFIT', labelEn: 'Profit', labelAr: 'الربح', amount: quote.pricing.profitAmount },
        { code: 'SALE_PRICE', labelEn: 'Sale price', labelAr: 'ثمن البيع', amount: quote.pricing.salePriceAmount },
      ],
    };
  },

  execute(terms, approved: Approved, quote, context): Result<Draft> {
    const core: TransactionCore = {
      transactionId: context.transactionId,
      tenantId: approved.core.tenantId,
      programmeId: approved.core.programmeId,
      counterpartyId: approved.core.counterpartyId,
      structureCode: terms.structureCode,
      structureDefinitionId: context.structure.definitionId,
      structureVersion: context.structure.version,
      shariahApprovalId: context.structure.shariahApprovalRef,
      riskPeriodRequiredSeconds: context.riskPeriodRequiredSeconds,
      pricing: quote.pricing,
      tenorDays: quote.tenorDays,
      maturityDateGregorian: context.maturityDateGregorian,
      maturityDateHijri: context.maturityDateHijri,
      tradeReference: approved.core.tradeReference,
      decisionId: context.decisionId,
      creditPolicyVersion: context.creditPolicyVersion,
      correlationId: context.correlationId,
    };
    return openTransaction(approved, core);
  },
};

/** Equal instalments in integer minor units; the remainder goes on the last one so the sum is exact. */
function split(total: Money, instalments: MurabahaTerms['instalments'], tenorDays: number): Quote['schedule'] {
  if (instalments === 'BULLET') return [{ at: { months: 0, days: tenorDays }, amount: total, direction: 'REPAYMENT' }];
  const n = BigInt(instalments.count);
  const base = total.minorUnits / n;
  const remainder = total.minorUnits - base * n;
  const step = Math.floor(tenorDays / instalments.count);
  return Array.from({ length: instalments.count }, (_, i) => ({
    at: { months: 0, days: i + 1 === instalments.count ? tenorDays : step * (i + 1) },
    amount: money(i + 1 === instalments.count ? base + remainder : base, total.currency),
    direction: 'REPAYMENT' as const,
  }));
}
