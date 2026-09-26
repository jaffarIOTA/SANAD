 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }










import { money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';


import { openTransaction } from './origination/open-transaction.js';
import { priceMurabaha } from './pricing/murabaha.js';


























const STRUCTURE_CODES = ['MURABAHA', 'SALAM', 'ISTISNA', 'IJARAH', 'MUSHARAKA'];
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export const murabahaScf = {
  descriptor: {
    code: 'murabaha-scf',
    nameEn: 'Murabaha supply-chain finance',
    nameAr: 'تمويل سلاسل الإمداد بالمرابحة',
    journeyShape: 'TRADE_FIRST',
    family: 'ISLAMIC',
    consumer: false,
    requiresBoardRuling: true,
  },

  validateTerms(raw) {
    if (!isRecord(raw)) return reject('OP-DETERMINACY', 'TERMS_MALFORMED', 'Murabaha terms are an object');
    const unknown = Object.keys(raw).filter((k) => !['instalments', 'structureCode', 'maxTenorDays'].includes(k));
    if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in Murabaha terms', { keys: unknown.join(',') });
    const inst = raw['instalments'];
    const instalments =
      inst === 'BULLET' ? 'BULLET' : isRecord(inst) && typeof inst['count'] === 'number' && Number.isInteger(inst['count']) && inst['count'] > 0 ? { count: inst['count'] } : undefined;
    if (instalments === undefined) return reject('OP-DETERMINACY', 'TERMS_INSTALMENTS', "instalments is 'BULLET' or { count }");
    if (!STRUCTURE_CODES.includes(raw['structureCode'] )) return reject('OP-DETERMINACY', 'TERMS_STRUCTURE', 'structureCode is one of the declared structures');
    if (typeof raw['maxTenorDays'] !== 'number' || !Number.isInteger(raw['maxTenorDays']) || raw['maxTenorDays'] <= 0) return reject('OP-DETERMINACY', 'TERMS_TENOR', 'maxTenorDays is a positive integer');
    return ok({ instalments, structureCode: raw['structureCode'] , maxTenorDays: raw['maxTenorDays'] });
  },

  quote(terms, request) {
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

  disclose(quote) {
    const repayments = quote.schedule.filter((f) => f.direction === 'REPAYMENT');
    const equal = repayments.every((f) => f.amount.minorUnits === _optionalChain([repayments, 'access', _2 => _2[0], 'optionalAccess', _3 => _3.amount, 'access', _4 => _4.minorUnits]));
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

  execute(terms, approved, quote, context) {
    const core = {
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
function split(total, instalments, tenorDays) {
  if (instalments === 'BULLET') return [{ at: { months: 0, days: tenorDays }, amount: total, direction: 'REPAYMENT' }];
  const n = BigInt(instalments.count);
  const base = total.minorUnits / n;
  const remainder = total.minorUnits - base * n;
  const step = Math.floor(tenorDays / instalments.count);
  return Array.from({ length: instalments.count }, (_, i) => ({
    at: { months: 0, days: i + 1 === instalments.count ? tenorDays : step * (i + 1) },
    amount: money(i + 1 === instalments.count ? base + remainder : base, total.currency),
    direction: 'REPAYMENT' ,
  }));
}
