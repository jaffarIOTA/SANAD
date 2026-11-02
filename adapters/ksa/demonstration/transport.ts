/**
 * The demonstration transport for the Saudi rails.
 *
 * The KSA counterpart of `adapters/uae/demonstration/transport.ts`: a fixture
 * transport that answers by rule instead of from a recorded list, so a whole
 * Saudi origination can be walked on the hosted synthetic environment and
 * show every outcome the real rails can give. It answers every operation the
 * KSA adapters call, in each adapter's assumed contract (the shapes recorded
 * in the adapter READMEs and docs/rails/public-structures.md), about the
 * synthetic cast in `cast.ts`; so the adapters' mapping, consent checks and
 * typed outcomes run exactly as they will against the live rails, and only
 * the answer is invented.
 *
 * Pure: no I/O and no state; the only input besides the request is the clock
 * it is given (dates such as certificate validity and bank history are kept
 * relative to it). It is selected only where a synthetic demonstration is
 * permitted (the process declares synthetic data and the database confirms
 * it, SR-005); everywhere else the rails are live or unavailable. Every
 * answer it gives is labelled FIXTURE wherever it is shown. Wiring it into an
 * app is a separate step.
 *
 * Steering rules, so a demonstration can be driven from the form:
 *   Nafath     an applicant reference containing "reject" is REJECTED in the
 *              app, "expire" EXPIRED, "wait" stays WAITING; otherwise the
 *              person approves and the status call answers COMPLETED.
 *   Yakeen     a reference containing "mismatch" fails on date of birth,
 *              "expired-id" on ID expiry, "unknown" is not on record (404);
 *              otherwise the person's attributes are returned.
 *   Wathq      a CR ending 9999 is struck off (status 3), 8888 suspended
 *              (status 2), 0000 not on the register (404.2.1); a cast CR or
 *              CR national number answers the cast company; any other
 *              ten-digit number is a generic active company.
 *   Bureau     (SIMAH and Bayan) a member reference that is a cast person
 *              answers that person's consumer report; a cast CR answers the
 *              company's commercial report; a CR starting DEF, or a cast
 *              company flagged bureauDefault, carries an unsettled default; a
 *              CR ending 0000 or a member reference containing "norecord" has
 *              no file. Reporting acknowledges by idempotency key.
 *   GOSI       a cast person answers their wage certificate; "unemployed" has
 *              no active employment; "unknown" is not a contributor (404).
 *   ZATCA tax  a cast company answers its certificate (company 2 is expired);
 *              a CR ending 7777 is expired, 0000 has no certificate (404).
 *   Fatoora    an invoice hash containing "reject" is NOT_CLEARED with error
 *              BR-KSA-F-06, "simplified" is REPORTED, "unknown" is 404;
 *              otherwise CLEARED with PASS. No QR stamp is produced, so the
 *              adapter's stamp check reports it invalid: the demonstration
 *              cannot sign as the authority, and says so.
 *   AIS        the x-sanad-applicant-ref header picks a cast person's twelve
 *              months of history; "noaccount" has no SAR account, "unknown"
 *              is 404; other references get a generic salaried profile.
 *   PIS        a reference containing "reject" is REJECTED.
 *   SADAD      a bill number containing "reject" is not presented; the
 *              reconciliation file holds one settled, one paid and one still
 *              presented bill under DEMO_SADAD_BILLER_ID.
 *   Payments   a reference containing "reject" is RJCT/AC04, "insufficient"
 *              RJCT/AM04, "pending" PDNG; a collection containing "return" is
 *              settled then returned (pacs.004); otherwise ACSC.
 *   Tahaqoq    a document reference containing "forged" is not authentic.
 */

import { type RailEnvelope, type RailTransport, TransportError } from '../../kernel/http-transport.ts';
import { decimalToMinor, minorToDecimal, own } from '../kernel/rail-adapter.ts';
import { monthStart } from '../open-banking/affordability.ts';
import {
  CAST_COMPANIES,
  CAST_PEOPLE,
  type CastBureauProfile,
  type CastCompany,
  type CastPerson,
  castCompany,
  castPerson,
} from './cast.ts';

type Answer = Readonly<Record<string, unknown>>;
type Rule = (e: RailEnvelope, now: number) => Answer;

/** The SADAD biller id the demonstration's reconciliation file is issued under; the demonstration wiring configures it. */
export const DEMO_SADAD_BILLER_ID = '901';

const DAY = 86_400;

// -- small deterministic helpers ---------------------------------------------------

/** FNV-1a, twice, as 16 hex characters: a stable, meaningless id from a seed. */
export function digest(seed: string): string {
  const fnv = (s: string, basis: number): string => {
    let h = basis >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return `${fnv(seed, 0x811c9dc5)}${fnv(seed, 0x01000193)}`;
}

const isoDay = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().slice(0, 10);
const isoTime = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');

const url = (e: RailEnvelope): URL => new URL(e.url);
const tail = (e: RailEnvelope): string => decodeURIComponent(url(e).pathname.split('/').pop() ?? '');
const body = (e: RailEnvelope, key: string): string => {
  const v = e.body?.[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
};
const has = (s: string, marker: string): boolean => s.toLowerCase().includes(marker);
const notFound = (operation: string, why: string): never => {
  throw new TransportError(operation, 404, why);
};

const sum = (...decimals: readonly string[]): string =>
  minorToDecimal(decimals.reduce((s, d) => s + (decimalToMinor(d) ?? 0n), 0n));

/** A person the cast does not name: a generic salaried profile under the reference asked about. */
function personFor(ref: string): CastPerson {
  const cast = castPerson(ref);
  if (cast !== undefined) return cast;
  const template = CAST_PEOPLE[1] as CastPerson;
  return {
    ...template,
    ref,
    displayNameEn: 'Demonstration applicant (synthetic)',
    displayNameAr: 'متقدم تجريبي (اصطناعي)',
    syntheticIdentity: `SYNTH-${digest(ref).slice(0, 10)}`,
  };
}

// -- Nafath --------------------------------------------------------------------------

const NAFATH_STEER = ['reject', 'expire', 'wait'] as const;

const nafathStart: Rule = (e) => {
  const applicantRef = body(e, 'applicantRef');
  const requestId = url(e).searchParams.get('requestId') ?? '';
  const steer = NAFATH_STEER.find((s) => has(applicantRef, s)) ?? 'approve';
  const id = digest(`${applicantRef}|${requestId}`);
  return { transId: `demo-${steer}-${id}`, random: String((Number.parseInt(id.slice(0, 2), 16) % 90) + 10) };
};

const nafathStatus: Rule = (e, now) => {
  const transId = body(e, 'transId');
  const m = /^demo-(approve|reject|expire|wait)-[0-9a-f]{16}$/.exec(transId);
  if (m === null) return notFound('identity.confirm', 'not a demonstration transaction');
  const status = own({ approve: 'COMPLETED', reject: 'REJECTED', expire: 'EXPIRED', wait: 'WAITING' }, m[1]);
  return status === 'COMPLETED' ? { status, transId, iat: now } : { status, transId };
};

// -- Yakeen --------------------------------------------------------------------------

const yakeen: Rule = (e, now) => {
  const ref = body(e, 'applicantRef');
  if (has(ref, 'unknown')) return notFound('identity.verify', 'no person on record');
  const logId = `YK-DEMO-${digest(`${ref}|${String(now)}`)}`;
  if (has(ref, 'mismatch'))
    return {
      logId,
      error: { code: 'DATE_OF_BIRTH_MISMATCH', message: 'Date of birth does not match (demonstration)' },
    };
  if (has(ref, 'expired-id')) return { logId, error: { code: 'ID_EXPIRED', message: 'ID expired (demonstration)' } };
  const person = personFor(ref);
  return { logId, operation: 'CitizenInfo', personInfo: { ...person.attributes } };
};

// -- Wathq ---------------------------------------------------------------------------

const WATHQ_STATUS_TEXT: Readonly<Record<number, { readonly name: string; readonly nameEn: string }>> = {
  1: { name: 'نشط', nameEn: 'Active' },
  2: { name: 'موقوف', nameEn: 'Suspended' },
  3: { name: 'مشطوب', nameEn: 'Struck off' },
};

function companyFor(cr: string): CastCompany {
  const cast = castCompany(cr);
  if (cast !== undefined) return cast;
  const national = cr.startsWith('7') ? cr : `700${cr.slice(3)}`;
  const crNumber = cr.startsWith('7') ? `1010${cr.slice(4)}` : cr;
  return {
    ...(CAST_COMPANIES[0] as CastCompany),
    crNumber,
    crNationalNumber: national,
    nameAr: 'شركة تجريبية عامة',
    nameEn: 'Generic Demonstration Company',
    ownerRefs: [`ksa-demo-owner-${cr}`],
    managerRefs: [`ksa-demo-owner-${cr}`],
    bureau: { score: 650, reasonCodes: [], facilities: [], defaults: [], judgments: [], enquiriesLast12Months: 0 },
    bureauDefault: false,
    zakat: { certificateNumber: `ZC-DEMO-${cr}`, state: 'VALID' },
    establishmentNumber: `5${cr.slice(-7)}`,
  };
}

const partyOf = (ref: string, role: string) => {
  const p = personFor(ref);
  return {
    name: p.displayNameAr,
    nameEn: p.displayNameEn,
    // Synthetic and not in a national format; the adapter drops identities whatever they hold.
    identity: { id: p.syntheticIdentity, type: 'SYNTHETIC' },
    typeName: role,
  };
};

const wathq: Rule = (e) => {
  const path = url(e).pathname;
  const cr = tail(e);
  if (!/^\d{10}$/.test(cr) || cr.endsWith('0000')) return notFound('registry.lookup', '404.2.1');
  const c = companyFor(cr);
  const statusId = cr.endsWith('9999') ? 3 : cr.endsWith('8888') ? 2 : c.statusId;
  const parties = c.ownerRefs.map((r) => partyOf(r, 'Partner'));
  const managers = c.managerRefs.map((r) => ({ ...partyOf(r, 'Manager'), positions: [{ name: 'Manager' }] }));
  if (path.includes('/owners/')) return { crNationalNumber: c.crNationalNumber, parties };
  if (path.includes('/managers/')) return { crNationalNumber: c.crNationalNumber, management: { managers } };
  const info = {
    crNationalNumber: c.crNationalNumber,
    crNumber: c.crNumber,
    name: c.nameAr,
    nameEn: c.nameEn,
    status: { id: statusId, ...(WATHQ_STATUS_TEXT[statusId] ?? WATHQ_STATUS_TEXT[1]) },
    entityType: c.entityType,
    issueDateGregorian: c.issueDateGregorian,
    capital: { currency: 'SAR', stockCapital: { paidAmount: c.paidCapital } },
    activities: c.activities,
  };
  return path.includes('/info/') ? info : { ...info, parties, management: { managers } };
};

// -- SIMAH and Bayan ------------------------------------------------------------------

const DEMO_DEFAULT = { amount: '75000.00', settled: false, defaultDate: '2025-11-30' } as const;

function report(
  product: string,
  reportId: string,
  now: number,
  subject: Answer,
  b: CastBureauProfile,
  isDefault: boolean,
) {
  const defaults = isDefault && !b.defaults.some((d) => !d.settled) ? [...b.defaults, DEMO_DEFAULT] : b.defaults;
  return {
    reportId,
    product,
    generatedAt: isoTime(now),
    subject: { found: true, ...subject },
    score: { value: b.score, model: 'DEMONSTRATION', reasonCodes: b.reasonCodes },
    facilities: b.facilities.map((f) => ({ ...f, currency: 'SAR' })),
    enquiries: Array.from({ length: b.enquiriesLast12Months }, (_x, i) => ({
      enquiryDate: isoDay(now - (i + 1) * 45 * DAY),
      memberType: 'BANK',
      purpose: 'NEW_CREDIT_APPLICATION',
    })),
    defaults: defaults.map((d) => ({ ...d, currency: 'SAR' })),
    judgments: b.judgments.map((j) => ({ ...j, currency: 'SAR' })),
  };
}

const bureauEnquiry: Rule = (e, now) => {
  const subject = (e.body?.['subject'] ?? {}) as Readonly<Record<string, unknown>>;
  const cr = typeof subject['crNumber'] === 'string' ? subject['crNumber'] : '';
  const member = typeof subject['memberReference'] === 'string' ? subject['memberReference'] : '';
  const product = body(e, 'product');
  const reportId = `BUREAU-DEMO-${digest(`${product}|${cr}|${member}|${String(now)}`)}`;
  if (has(member, 'norecord') || cr.endsWith('0000')) return { reportId, product, subject: { found: false } };
  const person = castPerson(member);
  if (person !== undefined)
    return report(product, reportId, now, { subjectType: 'CONSUMER', memberReference: member }, person.bureau, false);
  const company = companyFor(/^\d{10}$/.test(cr) ? cr : '1010000000');
  return report(
    product,
    reportId,
    now,
    { subjectType: 'COMMERCIAL', crNumber: cr },
    company.bureau,
    company.bureauDefault || cr.toUpperCase().startsWith('DEF'),
  );
};

const bureauReport: Rule = (e) => ({ acknowledgementId: `ACK-DEMO-${digest(body(e, 'idempotencyKey'))}` });

// -- GOSI ----------------------------------------------------------------------------

const gosi: Rule = (e, now) => {
  const ref = body(e, 'applicantRef');
  if (has(ref, 'unknown')) return notFound('employment.status', 'not a contributor');
  const person = personFor(ref);
  const employments = person.employment.map((x) => ({
    establishmentNumber: x.establishmentNumber,
    establishmentName: x.establishmentName,
    joiningDate: x.joiningDate,
    employmentStatus: has(ref, 'unemployed') ? 'INACTIVE' : x.employmentStatus,
    wage: {
      currency: 'SAR',
      basicWage: x.basicWage,
      housingAllowance: x.housingAllowance,
      otherAllowances: x.otherAllowances,
      totalWage: sum(x.basicWage, x.housingAllowance, x.otherAllowances),
    },
  }));
  return {
    certificateNumber: `GOSI-DEMO-${digest(`${ref}|${isoDay(now)}`)}`,
    issueDate: isoDay(now),
    // The certificate names the contributor; the adapter drops it.
    contributor: { name: person.displayNameAr, identity: person.syntheticIdentity, nationality: 'SAU' },
    employments,
  };
};

// -- ZATCA zakat certificate ------------------------------------------------------------

const zakat: Rule = (e, now) => {
  const cr = url(e).searchParams.get('crNumber') ?? '';
  if (cr.endsWith('0000')) return notFound('tax.certificate', 'no certificate');
  const c = companyFor(/^\d{10}$/.test(cr) ? cr : '1010000000');
  const expired = c.zakat.state === 'EXPIRED' || cr.endsWith('7777');
  return {
    certificateNumber: c.zakat.certificateNumber,
    certificateType: 'ZAKAT',
    status: expired ? 'EXPIRED' : 'VALID',
    issueDate: isoDay(expired ? now - 425 * DAY : now - 120 * DAY),
    expiryDate: isoDay(expired ? now - 60 * DAY : now + 245 * DAY),
    taxpayer: { crNumber: cr, nameAr: c.nameAr },
  };
};

// -- ZATCA Fatoora -----------------------------------------------------------------------

const PASS_INFO = {
  type: 'INFO',
  code: 'XSD_ZATCA_VALID',
  category: 'XSD validation',
  message: 'Complied with UBL 2.1 standards in line with ZATCA specifications',
  status: 'PASS',
};

/**
 * An invoice the wiring tells the demonstration about: who issued it, to whom, for how much. Used where a
 * demonstration needs an invoice between particular parties (Wasl's ownership invoice from the anchor to the
 * institution); every other lookup answers about the cast. The steering markers in the hash still apply.
 */
export interface DemonstrationInvoice {
  readonly sellerCr: string;
  readonly buyerCr: string;
  /** Tax-inclusive total, in minor units. */
  readonly totalMinor: bigint;
}

const einvoiceLookupWith =
  (book: (invoiceUuid: string) => DemonstrationInvoice | undefined): Rule =>
  (e, now) => {
    const uuid = tail(e);
    const hash = url(e).searchParams.get('hash') ?? '';
    if (has(hash, 'unknown')) return notFound('einvoice.lookup', 'no such invoice');
    const known = book(uuid);
    const seller = CAST_COMPANIES[0] as CastCompany;
    const buyer = CAST_COMPANIES[2] as CastCompany;
    const total = known === undefined ? '115000.00' : minorToDecimal(known.totalMinor);
    const net = known === undefined ? '100000.00' : total;
    const invoice = {
      id: `INV-DEMO-${digest(uuid).slice(0, 8)}`,
      uuid,
      issueDate: isoDay(now - (known === undefined ? 30 : 0) * DAY),
      seller: { crNumber: known?.sellerCr ?? seller.crNumber, name: seller.nameAr },
      buyer: { crNumber: known?.buyerCr ?? buyer.crNumber, name: buyer.nameAr },
      taxExclusiveAmount: net,
      taxAmount: known === undefined ? '15000.00' : '0.00',
      taxInclusiveAmount: total,
      invoiceLines: [
        {
          id: 1,
          itemName: 'Demonstration goods',
          itemNameAr: 'بضائع تجريبية',
          itemClassificationCode: '469000',
          invoicedQuantity: '100',
          unitCode: 'PCE',
          lineExtensionAmount: net,
        },
      ],
    };
    if (has(hash, 'reject'))
      return {
        validationResults: {
          infoMessages: [],
          warningMessages: [],
          errorMessages: [
            {
              type: 'ERROR',
              code: 'BR-KSA-F-06',
              category: 'KSA',
              message: 'Field does not meet the allowed length (demonstration)',
              status: 'ERROR',
            },
          ],
          status: 'ERROR',
        },
        clearanceStatus: 'NOT_CLEARED',
        invoice,
      };
    const validationResults = { infoMessages: [PASS_INFO], warningMessages: [], errorMessages: [], status: 'PASS' };
    return has(hash, 'simplified')
      ? { validationResults, reportingStatus: 'REPORTED', invoice }
      : { validationResults, clearanceStatus: 'CLEARED', invoice };
  };

const einvoiceLookup: Rule = einvoiceLookupWith(() => undefined);

const einvoiceHistory: Rule = (e) => {
  const seller = body(e, 'sellerCr');
  const buyers = CAST_COMPANIES.filter((c) => c.crNumber !== seller && c.crNationalNumber !== seller);
  const perBuyer = buyers.map((b, i) => ({
    buyerCr: b.crNumber,
    invoiceCount: 12 + i * 7,
    totalValue: minorToDecimal(BigInt(12 + i * 7) * 9_250_000n),
    medianDaysToPayment: 38 + i * 9,
    creditNoteCount: i,
  }));
  return {
    clearedInvoiceCount: perBuyer.reduce((s, b) => s + b.invoiceCount, 0),
    totalClearedValue: sum(...perBuyer.map((b) => b.totalValue)),
    distinctBuyerCount: perBuyer.length,
    perBuyer,
  };
};

// -- Open Banking AIS ----------------------------------------------------------------------

interface DemoTransaction {
  readonly AccountId: string;
  readonly TransactionId: string;
  readonly TransactionReference: string;
  readonly TransactionType: string;
  readonly CreditDebitIndicator: 'KSAOB.Credit' | 'KSAOB.Debit';
  readonly Status: 'KSAOB.Booked' | 'KSAOB.Rejected';
  readonly BookingDateTime: string;
  readonly ValueDateTime: string;
  readonly Amount: { readonly Amount: string; readonly Currency: 'SAR' };
  readonly TransactionInformation: string;
  readonly Flags?: readonly string[];
}

const HISTORY_MONTHS = 12;
const PAGE_SIZE = 40;

const applicantOf = (e: RailEnvelope): string => e.headers['x-sanad-applicant-ref'] ?? '';
const currentAccount = (ref: string): string => `${ref}-SAR-CURRENT`;

/** Twelve complete months of a person's current-account lines, oldest first. */
export function history(person: CastPerson, now: number): DemoTransaction[] {
  const b = person.bank;
  const account = currentAccount(person.ref);
  const out: DemoTransaction[] = [];
  for (let back = HISTORY_MONTHS; back >= 1; back -= 1) {
    const start = Number(monthStart(BigInt(now), back));
    const on = (day: number) => `${isoDay(start + (day - 1) * DAY)}T09:00:00+03:00`;
    const line = (
      kind: string,
      day: number,
      type: string,
      credit: boolean,
      value: string,
      info: string,
      extra: { readonly Flags?: readonly string[]; readonly rejected?: boolean } = {},
    ): DemoTransaction => ({
      AccountId: account,
      TransactionId: `${account}-${isoDay(start).slice(0, 7)}-${kind}`,
      TransactionReference: `DEMO-${digest(`${account}|${String(start)}|${kind}`).slice(0, 10)}`,
      TransactionType: type,
      CreditDebitIndicator: credit ? 'KSAOB.Credit' : 'KSAOB.Debit',
      Status: extra.rejected === true ? 'KSAOB.Rejected' : 'KSAOB.Booked',
      BookingDateTime: on(day),
      ValueDateTime: on(day),
      Amount: { Amount: value, Currency: 'SAR' },
      TransactionInformation: info,
      ...(extra.Flags === undefined ? {} : { Flags: extra.Flags }),
    });
    out.push(line('rent', 1, 'KSAOB.LocalBankTransfer', false, b.monthlyRent, 'Rent (demonstration)'));
    out.push(line('bills', 10, 'KSAOB.SADAD', false, b.monthlyBills, 'Utility bills (demonstration)'));
    out.push(line('card', 15, 'KSAOB.POS', false, b.monthlyCardSpend, 'Card spend (demonstration)'));
    if (b.monthlyLoanInstalment !== undefined)
      out.push(
        line('loan', 20, 'KSAOB.LocalBankTransfer', false, b.monthlyLoanInstalment, 'Finance instalment', {
          Flags: ['KSAOB.Loan'],
        }),
      );
    if (back <= b.rejectedDebitsLast6Months)
      out.push(
        line('returned', 22, 'KSAOB.LocalBankTransfer', false, '1500.00', 'Returned payment (demonstration)', {
          rejected: true,
        }),
      );
    out.push(
      line('salary', 27, 'KSAOB.LocalBankTransfer', true, b.monthlySalary, 'Salary (demonstration)', {
        Flags: ['KSAOB.Payroll'],
      }),
    );
  }
  return out;
}

/** The booked balance now: the opening balance plus every booked line. */
export function bookedBalance(person: CastPerson, now: number): bigint {
  return history(person, now)
    .filter((t) => t.Status === 'KSAOB.Booked')
    .reduce(
      (s, t) => s + (t.CreditDebitIndicator === 'KSAOB.Credit' ? 1n : -1n) * (decimalToMinor(t.Amount.Amount) ?? 0n),
      decimalToMinor(person.bank.openingBalance) ?? 0n,
    );
}

const envelope = (e: RailEnvelope, data: Answer, next?: string): Answer => ({
  Data: data,
  Links: { Self: e.url, ...(next === undefined ? {} : { Next: next }) },
  Meta: { TotalPages: next === undefined ? 1 : 2 },
});

function aisPerson(e: RailEnvelope, operation: string): CastPerson | undefined {
  const ref = applicantOf(e);
  if (has(ref, 'unknown')) return notFound(operation, 'no such PSU');
  return has(ref, 'noaccount') ? undefined : personFor(ref);
}

const aisAccounts: Rule = (e) => {
  const person = aisPerson(e, 'ais.accounts');
  if (person === undefined) return envelope(e, { Account: [] });
  const accounts = [
    {
      AccountId: currentAccount(person.ref),
      Currency: 'SAR',
      AccountType: 'KSAOB.Retail',
      AccountSubType: 'KSAOB.CurrentAccount',
      Nickname: 'Demonstration current account',
    },
    ...(person.bank.foreignCurrencyAccount === true
      ? [
          {
            AccountId: `${person.ref}-USD-SAVINGS`,
            Currency: 'USD',
            AccountType: 'KSAOB.Retail',
            AccountSubType: 'KSAOB.Savings',
            Nickname: 'Demonstration dollar savings',
          },
        ]
      : []),
  ];
  return envelope(e, { Account: accounts });
};

const accountOwner = (e: RailEnvelope, operation: string): CastPerson => {
  const parts = url(e).pathname.split('/');
  const accountId = decodeURIComponent(parts[parts.indexOf('accounts') + 1] ?? '');
  const person = aisPerson(e, operation);
  if (person === undefined || accountId !== currentAccount(person.ref)) return notFound(operation, 'no such account');
  return person;
};

const aisBalances: Rule = (e, now) => {
  const person = accountOwner(e, 'ais.balances');
  const balance = bookedBalance(person, now);
  const amount = {
    CreditDebitIndicator: balance < 0n ? 'KSAOB.Debit' : 'KSAOB.Credit',
    Amount: { Amount: minorToDecimal(balance < 0n ? -balance : balance), Currency: 'SAR' },
  };
  const AccountId = currentAccount(person.ref);
  return envelope(e, {
    Balance: [
      { AccountId, Type: 'KSAOB.InterimAvailable', DateTime: isoTime(now), ...amount },
      { AccountId, Type: 'KSAOB.InterimBooked', DateTime: isoTime(now), ...amount },
    ],
  });
};

const aisTransactions: Rule = (e, now) => {
  const person = accountOwner(e, 'ais.transactions');
  const u = url(e);
  const from = Date.parse(u.searchParams.get('fromBookingDateTime') ?? '');
  const to = Date.parse(u.searchParams.get('toBookingDateTime') ?? '');
  const lines = history(person, now).filter((t) => {
    const at = Date.parse(t.BookingDateTime);
    return (Number.isNaN(from) || at >= from) && (Number.isNaN(to) || at <= to);
  });
  const page = Math.max(1, Number.parseInt(u.searchParams.get('page') ?? '1', 10) || 1);
  const slice = lines.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  let next: string | undefined;
  if (page * PAGE_SIZE < lines.length) {
    const n = new URL(u.toString());
    n.searchParams.set('page', String(page + 1));
    next = n.toString();
  }
  return envelope(e, { Transaction: slice }, next);
};

// -- Open Banking PIS (inferred shape) ----------------------------------------------------

const pisInitiate: Rule = (e, now) => {
  const reject = has(body(e, 'reference'), 'reject');
  return {
    paymentId: `PIS-DEMO-${reject ? 'REJECT-' : ''}${digest(body(e, 'idempotencyKey'))}`,
    status: reject ? 'REJECTED' : 'INITIATED',
    initiatedAt: now,
  };
};

const pisStatus: Rule = (e) => ({ status: has(tail(e), 'reject') ? 'REJECTED' : 'SETTLED' });

// -- SADAD --------------------------------------------------------------------------------

const billPresent: Rule = (e, now) => {
  const details = (e.body?.['BillDetails'] ?? {}) as Readonly<Record<string, unknown>>;
  const billNumber = typeof details['BillNumber'] === 'string' ? details['BillNumber'] : '';
  return {
    BillDetails: { BillerID: details['BillerID'], BillNumber: billNumber },
    Status: has(billNumber, 'reject') ? 'REJECTED' : 'PRESENTED',
    PresentedDateTime: isoTime(now),
  };
};

const billReconciliation: Rule = (e, now) => {
  const from = Date.parse(url(e).searchParams.get('fromDateTime') ?? '');
  const bill = (n: string, status: string, paidDaysAgo: number, value: string, settled: boolean) => ({
    BillDetails: { BillerID: DEMO_SADAD_BILLER_ID, BillNumber: `DEMO-OBL-${n}` },
    Status: status,
    PaidAmount: { Amount: value, Currency: 'SAR' },
    PaymentDateTime: isoTime(now - paidDaysAgo * DAY),
    SadadPaymentId: `SADAD-DEMO-${n}`,
    ...(settled ? { SettlementReference: `SETTLE-DEMO-${n}` } : {}),
  });
  const bills = [
    bill('0001', 'SETTLED', 2, '3100.00', true),
    bill('0002', 'PAID', 0, '2325.00', false),
    { ...bill('0003', 'PRESENTED', 0, '4650.00', false), PaidAmount: undefined, PaymentDateTime: undefined },
  ].filter((b) => b.PaymentDateTime === undefined || Number.isNaN(from) || Date.parse(b.PaymentDateTime) >= from);
  return { Data: { Bill: bills }, Links: { Self: e.url }, Meta: { TotalPages: 1 } };
};

// -- Payments hub (ISO 20022 pacs.002) -------------------------------------------------------

const payment =
  (collection: boolean): Rule =>
  (e, now) => {
    const reference = body(e, 'EndToEndId');
    const instrId = body(e, 'InstrId');
    const rejected = has(reference, 'reject') ? 'AC04' : has(reference, 'insufficient') ? 'AM04' : undefined;
    const status = rejected !== undefined ? 'RJCT' : has(reference, 'pending') ? 'PDNG' : 'ACSC';
    return {
      OrgnlEndToEndId: reference,
      OrgnlInstrId: instrId,
      TxId: `HUB-DEMO-${digest(instrId)}`,
      TxSts: status,
      AccptncDtTm: isoTime(now),
      ...(rejected === undefined ? {} : { StsRsnInf: { Rsn: { Cd: rejected } } }),
      ...(collection && status === 'ACSC' && has(reference, 'return') ? { RtrInf: { Rsn: { Cd: 'MD06' } } } : {}),
    };
  };

// -- Tahaqoq, rate publisher, commodity broker (Sanad's own assumed vocabulary) ----------------

const tahaqoq: Rule = (e, now) => ({
  authentic: !has(body(e, 'reference'), 'forged'),
  verificationId: `THQ-DEMO-${digest(body(e, 'reference'))}`,
  issuedAt: now - 200 * DAY,
  expiresAt: now + 165 * DAY,
});

/** Illustrative benchmark figures for a demonstration; not market data. */
const BENCHMARKS: Readonly<Record<string, string>> = {
  'SAIBOR-1M': '5.40',
  'SAIBOR-3M': '5.55',
  'SAIBOR-6M': '5.60',
  'SAMA-REPO': '5.00',
};
const asOfOf = (e: RailEnvelope, now: number): number =>
  Number.parseInt(url(e).searchParams.get('asOf') ?? '', 10) || now;

const benchmark: Rule = (e, now) => {
  const code = tail(e);
  const ratePercent = own(BENCHMARKS, code);
  if (ratePercent === undefined) return notFound('rates.benchmark', 'no such benchmark');
  return { ratePercent, asOf: asOfOf(e, now), publicationId: `RP-DEMO-${digest(`${code}|${isoDay(asOfOf(e, now))}`)}` };
};

const market: Rule = (e, now) => ({
  lowPercent: '8.50',
  medianPercent: '12.75',
  highPercent: '19.90',
  asOf: asOfOf(e, now),
  publicationId: `RP-DEMO-${digest(`${tail(e)}|${isoDay(asOfOf(e, now))}`)}`,
});

const commodityPurchase: Rule = (e, now) => {
  const minor = /^\d+$/.test(body(e, 'amount')) ? BigInt(body(e, 'amount')) : 0n;
  return {
    lotId: `LOT-DEMO-${minor.toString()}-${digest(body(e, 'idempotencyKey')).slice(0, 8)}`,
    quantity: '10',
    unit: 'MT',
    price: minorToDecimal(minor),
    confirmedAt: now,
  };
};

const lotOf = (e: RailEnvelope): string => {
  const parts = url(e).pathname.split('/');
  return decodeURIComponent(parts[parts.indexOf('lots') + 1] ?? '');
};

const commodityTransfer: Rule = (e, now) => ({ transferId: `TRF-DEMO-${digest(lotOf(e))}`, confirmedAt: now });

const commoditySell: Rule = (e, now) => {
  const m = /^LOT-DEMO-(\d+)-/.exec(lotOf(e));
  if (m === null) return notFound('commodity.sell', 'no such lot');
  return { saleId: `SALE-DEMO-${digest(lotOf(e))}`, proceeds: minorToDecimal(BigInt(m[1] ?? '0')), confirmedAt: now };
};

/** Every operation the KSA adapters call, by the operation name the adapter gives its transport. */
export const KSA_DEMONSTRATION_RULES: Readonly<Record<string, Rule>> = {
  'identity.start': nafathStart,
  'identity.confirm': nafathStatus,
  'identity.verify': yakeen,
  'registry.lookup': wathq,
  'bureau.enquiry': bureauEnquiry,
  'bureau.report': bureauReport,
  'employment.status': gosi,
  'tax.certificate': zakat,
  'einvoice.lookup': einvoiceLookup,
  'einvoice.history': einvoiceHistory,
  'ais.accounts': aisAccounts,
  'ais.balances': aisBalances,
  'ais.transactions': aisTransactions,
  'pis.initiate': pisInitiate,
  'pis.status': pisStatus,
  'bill.present': billPresent,
  'bill.paid': billReconciliation,
  'payments.disburse': payment(false),
  'payments.collect': payment(true),
  'document.verify': tahaqoq,
  'rates.benchmark': benchmark,
  'rates.market': market,
  'commodity.purchase': commodityPurchase,
  'commodity.transfer': commodityTransfer,
  'commodity.sell': commoditySell,
};

export class KsaDemonstrationTransport implements RailTransport {
  readonly #einvoiceLookup: Rule | undefined;

  /**
   * `now` is the clock the relative dates hang from; the hosted demonstration passes the server's.
   * `invoices`, where given, names the parties and total of particular invoices by UUID.
   */
  constructor(
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    invoices?: (invoiceUuid: string) => DemonstrationInvoice | undefined,
  ) {
    this.#einvoiceLookup = invoices === undefined ? undefined : einvoiceLookupWith(invoices);
  }

  async call(operation: string, e: RailEnvelope): Promise<Readonly<Record<string, unknown>>> {
    const rule =
      operation === 'einvoice.lookup' && this.#einvoiceLookup !== undefined
        ? this.#einvoiceLookup
        : own(KSA_DEMONSTRATION_RULES, operation);
    // An operation without a rule is a gap in the demonstration, said plainly rather than answered.
    if (rule === undefined) throw new TransportError(operation, 501, `no demonstration rule for ${operation}`);
    return Promise.resolve(rule(e, this.now()));
  }
}
