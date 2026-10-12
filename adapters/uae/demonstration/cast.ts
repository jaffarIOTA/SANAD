/**
 * The demonstration cast: a small, fixed, ENTIRELY SYNTHETIC set of UAE
 * businesses and the people behind them, so a demonstration can walk one
 * company through every rail and get answers that agree with each other —
 * the register's owners are the bureau's subjects, the WPS establishment
 * pays the payroll the bank statement shows, the TRN the tax check confirms
 * is the one the register lists.
 *
 * Every name says "Synthetic". No entry is, or is modelled on, a real
 * business or person; licence numbers, TRNs and references are invented in
 * shapes that cannot collide with the steering prefixes in transport.ts.
 *
 * Vendor-neutral on purpose: amounts are AED minor units (bigint), dates are
 * ISO strings, statuses are plain words. The demonstration transport renders
 * this into each rail's assumed response shape.
 */

/** The instant every demonstration answer is "as of": 2027-01-15T08:00:00Z (12:00 in the UAE). */
export const CAST_AS_OF_EPOCH = 1_800_000_000;
export const CAST_AS_OF_ISO = '2027-01-15T12:00:00+04:00';
/** Twelve complete months of history before the as-of month, then the as-of month to the 14th. */
export const CAST_HISTORY_MONTHS: readonly string[] = [
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
  '2026-11',
  '2026-12',
  '2027-01',
];

export type ContractStatus = 'ACTIVE' | 'RESTRUCTURED' | 'DEFAULTED' | 'WRITTEN_OFF' | 'CLOSED' | 'SETTLED';

export interface CastContract {
  readonly ref: string;
  readonly type: 'TERM_LOAN' | 'OVERDRAFT' | 'CREDIT_CARD' | 'TRADE_FINANCE' | 'PERSONAL_LOAN' | 'AUTO_LOAN';
  readonly role: 'PRIMARY' | 'JOINT' | 'GUARANTOR';
  readonly status: ContractStatus;
  readonly openedOn: string;
  readonly limitMinor: bigint;
  readonly outstandingMinor: bigint;
  readonly overdueMinor: bigint;
  readonly daysPastDue: number;
  /** Days past due in each of the last six months, oldest first. */
  readonly history: readonly number[];
}

export interface CastBureau {
  /** False: the bureau has no file on the subject. */
  readonly found: boolean;
  readonly score?: number;
  readonly band?: 'A' | 'B' | 'C' | 'D' | 'E';
  readonly reasonCodes: readonly string[];
  readonly contracts: readonly CastContract[];
  readonly bouncedCheques: readonly {
    readonly date: string;
    readonly amountMinor: bigint;
    readonly settled: boolean;
  }[];
  readonly courtCases: readonly {
    readonly ref: string;
    readonly status: 'OPEN' | 'CLOSED';
    readonly claimMinor: bigint;
  }[];
  readonly enquiries: readonly { readonly date: string; readonly sector: string }[];
}

export interface CastSalary {
  readonly employerLicence: string;
  readonly since: string;
  readonly fixedMinor: bigint;
  readonly variableMinor: bigint;
}

export interface CastParty {
  readonly ref: string;
  readonly displayName: string;
  readonly displayNameAr: string;
  /** An officer role on the register, where the person manages the business. */
  readonly officerRole?: 'manager' | 'director' | 'partner';
  /** Ownership in hundredths of a percent; 0 for a manager who owns nothing. */
  readonly ownershipPerTenThousand: number;
  readonly naturesOfControl: readonly string[];
  readonly nationality: string;
  readonly bureau: CastBureau;
  /** Where the person is an employee paid through WPS. */
  readonly salary?: CastSalary;
}

export interface CastWpsMonth {
  /** YYYY-MM */
  readonly month: string;
  readonly employeesDue: number;
  readonly employeesPaid: number;
  readonly totalMinor: bigint;
}

export type BankLineKind = 'REVENUE' | 'PAYROLL' | 'RENT' | 'SUPPLIER' | 'FINANCE' | 'SALARY' | 'SPEND' | 'CARD_FX';

export interface BankPattern {
  readonly kind: BankLineKind;
  readonly day: number;
  readonly amountMinor: bigint;
  /** Varies the amount by up to ±5% month to month, deterministically. */
  readonly varies: boolean;
}

export interface CastBank {
  readonly accountKey: string;
  readonly accountType: 'Retail' | 'SME' | 'Corporate';
  readonly isShariaCompliant: boolean;
  readonly openingBalanceMinor: bigint;
  readonly monthly: readonly BankPattern[];
  /** Months (YYYY-MM) in which an outgoing cheque was returned unpaid. */
  readonly returnedMonths: readonly string[];
}

export interface CastCompany {
  readonly licence: string;
  readonly issuingAuthority: { readonly code: string; readonly nameEn: string };
  readonly economicRegisterNumber: string;
  readonly trn: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly legalForm: 'llc' | 'sole-establishment' | 'civil-company';
  readonly incorporatedOn: string;
  readonly licenceExpiresOn: string;
  readonly isic4: readonly { readonly code: string; readonly descriptionEn: string }[];
  readonly shareCapitalMinor: bigint;
  readonly emirate: string;
  readonly parties: readonly CastParty[];
  readonly bureau: CastBureau;
  readonly wps: { readonly establishmentRef: string; readonly months: readonly CastWpsMonth[] };
  readonly bank: CastBank;
}

const CLEAN: Pick<CastBureau, 'bouncedCheques' | 'courtCases'> = { bouncedCheques: [], courtCases: [] };
const flat = (n: number): readonly number[] => [n, n, n, n, n, n];

/** Twelve WPS months with the same headcount, except where an override says otherwise. */
function wpsYear(
  employees: number,
  totalMinor: bigint,
  overrides: Readonly<Record<string, number>> = {},
): readonly CastWpsMonth[] {
  return CAST_HISTORY_MONTHS.slice(0, 12).map((month) => {
    const paid = overrides[month] ?? employees;
    return {
      month,
      employeesDue: employees,
      employeesPaid: paid,
      totalMinor: (totalMinor * BigInt(paid)) / BigInt(employees),
    };
  });
}

export const CAST: readonly CastCompany[] = [
  {
    licence: 'CN-1001001',
    issuingAuthority: { code: 'ADDED', nameEn: 'Abu Dhabi Department of Economic Development' },
    economicRegisterNumber: 'ERN-0001001001',
    trn: '100100100100003',
    nameEn: 'Synthetic Falcon Trading LLC',
    nameAr: 'شركة الصقر الاصطناعية للتجارة ذ.م.م',
    legalForm: 'llc',
    incorporatedOn: '2018-03-11',
    licenceExpiresOn: '2027-03-10',
    isic4: [{ code: '4690', descriptionEn: 'Non-specialized wholesale trade' }],
    shareCapitalMinor: 30_000_000n,
    emirate: 'Abu Dhabi',
    parties: [
      {
        ref: 'demo-falcon-owner-1',
        displayName: 'Synthetic Owner Falcon One',
        displayNameAr: 'مالك الصقر الاصطناعي الأول',
        officerRole: 'manager',
        ownershipPerTenThousand: 6000,
        naturesOfControl: ['ownership-of-shares-50-to-75-percent', 'right-to-appoint-and-remove-directors'],
        nationality: 'Synthetic',
        bureau: {
          found: true,
          score: 781,
          band: 'A',
          reasonCodes: ['R10'],
          contracts: [
            {
              ref: 'ind-falcon-1-card',
              type: 'CREDIT_CARD',
              role: 'PRIMARY',
              status: 'ACTIVE',
              openedOn: '2016-05-01',
              limitMinor: 6_000_000n,
              outstandingMinor: 820_000n,
              overdueMinor: 0n,
              daysPastDue: 0,
              history: flat(0),
            },
          ],
          enquiries: [{ date: '2026-12-02', sector: 'BANK' }],
          ...CLEAN,
        },
      },
      {
        ref: 'demo-falcon-owner-2',
        displayName: 'Synthetic Owner Falcon Two',
        displayNameAr: 'مالك الصقر الاصطناعي الثاني',
        ownershipPerTenThousand: 4000,
        naturesOfControl: ['ownership-of-shares-25-to-50-percent'],
        nationality: 'Synthetic',
        bureau: {
          found: true,
          score: 744,
          band: 'A',
          reasonCodes: ['R12'],
          contracts: [
            {
              ref: 'ind-falcon-2-auto',
              type: 'AUTO_LOAN',
              role: 'PRIMARY',
              status: 'ACTIVE',
              openedOn: '2024-02-15',
              limitMinor: 12_000_000n,
              outstandingMinor: 7_350_000n,
              overdueMinor: 0n,
              daysPastDue: 0,
              history: flat(0),
            },
          ],
          enquiries: [],
          ...CLEAN,
        },
      },
    ],
    bureau: {
      found: true,
      score: 742,
      band: 'A',
      reasonCodes: ['C01', 'C14'],
      contracts: [
        {
          ref: 'com-falcon-term',
          type: 'TERM_LOAN',
          role: 'PRIMARY',
          status: 'ACTIVE',
          openedOn: '2023-06-01',
          limitMinor: 120_000_000n,
          outstandingMinor: 64_000_000n,
          overdueMinor: 0n,
          daysPastDue: 0,
          history: flat(0),
        },
        {
          ref: 'com-falcon-od',
          type: 'OVERDRAFT',
          role: 'PRIMARY',
          status: 'ACTIVE',
          openedOn: '2019-01-10',
          limitMinor: 25_000_000n,
          outstandingMinor: 8_500_000n,
          overdueMinor: 0n,
          daysPastDue: 0,
          history: flat(0),
        },
      ],
      enquiries: [{ date: '2026-11-20', sector: 'BANK' }],
      ...CLEAN,
    },
    wps: { establishmentRef: 'est-demo-falcon', months: wpsYear(24, 18_000_000n, { '2026-04': 23 }) },
    bank: {
      accountKey: 'falcon',
      accountType: 'SME',
      isShariaCompliant: false,
      openingBalanceMinor: 60_000_000n,
      monthly: [
        { kind: 'RENT', day: 1, amountMinor: 2_500_000n, varies: false },
        { kind: 'FINANCE', day: 3, amountMinor: 2_800_000n, varies: false },
        { kind: 'REVENUE', day: 5, amountMinor: 15_000_000n, varies: true },
        { kind: 'SUPPLIER', day: 10, amountMinor: 9_000_000n, varies: true },
        { kind: 'REVENUE', day: 15, amountMinor: 15_000_000n, varies: true },
        { kind: 'SUPPLIER', day: 20, amountMinor: 9_000_000n, varies: true },
        { kind: 'REVENUE', day: 25, amountMinor: 15_000_000n, varies: true },
        { kind: 'PAYROLL', day: 27, amountMinor: 18_000_000n, varies: false },
      ],
      returnedMonths: [],
    },
  },
  {
    licence: 'DXB-2002002',
    issuingAuthority: { code: 'DET', nameEn: 'Dubai Department of Economy and Tourism' },
    economicRegisterNumber: 'ERN-0002002002',
    trn: '100200200200003',
    nameEn: 'Synthetic Oasis Foodstuff Trading LLC',
    nameAr: 'شركة الواحة الاصطناعية لتجارة المواد الغذائية ذ.م.م',
    legalForm: 'llc',
    incorporatedOn: '2015-09-20',
    licenceExpiresOn: '2027-09-19',
    isic4: [
      { code: '4630', descriptionEn: 'Wholesale of food, beverages and tobacco' },
      { code: '5210', descriptionEn: 'Warehousing and storage' },
    ],
    shareCapitalMinor: 50_000_000n,
    emirate: 'Dubai',
    parties: [
      {
        ref: 'demo-oasis-owner-1',
        displayName: 'Synthetic Owner Oasis One',
        displayNameAr: 'مالك الواحة الاصطناعي',
        officerRole: 'manager',
        ownershipPerTenThousand: 10_000,
        naturesOfControl: ['ownership-of-shares-75-to-100-percent', 'voting-rights-75-to-100-percent'],
        nationality: 'Synthetic',
        bureau: {
          found: true,
          score: 655,
          band: 'C',
          reasonCodes: ['R31', 'R44'],
          contracts: [
            {
              ref: 'ind-oasis-1-card',
              type: 'CREDIT_CARD',
              role: 'PRIMARY',
              status: 'ACTIVE',
              openedOn: '2014-03-01',
              limitMinor: 5_000_000n,
              outstandingMinor: 4_650_000n,
              overdueMinor: 310_000n,
              daysPastDue: 31,
              history: [0, 0, 30, 0, 31, 31],
            },
            {
              ref: 'com-oasis-term-guarantee',
              type: 'TERM_LOAN',
              role: 'GUARANTOR',
              status: 'ACTIVE',
              openedOn: '2022-01-15',
              limitMinor: 150_000_000n,
              outstandingMinor: 90_000_000n,
              overdueMinor: 4_200_000n,
              daysPastDue: 35,
              history: [0, 30, 62, 31, 0, 35],
            },
          ],
          enquiries: [
            { date: '2026-10-04', sector: 'BANK' },
            { date: '2026-12-18', sector: 'FINANCE_COMPANY' },
          ],
          ...CLEAN,
        },
      },
      {
        ref: 'demo-oasis-manager-1',
        displayName: 'Synthetic Manager Oasis',
        displayNameAr: 'مدير الواحة الاصطناعي',
        officerRole: 'manager',
        ownershipPerTenThousand: 0,
        naturesOfControl: [],
        nationality: 'Synthetic',
        bureau: { found: false, reasonCodes: [], contracts: [], enquiries: [], ...CLEAN },
        salary: {
          employerLicence: 'DXB-2002002',
          since: '2019-02-01',
          fixedMinor: 1_850_000n,
          variableMinor: 120_000n,
        },
      },
    ],
    bureau: {
      found: true,
      score: 618,
      band: 'C',
      reasonCodes: ['C22', 'C31', 'C40'],
      contracts: [
        {
          ref: 'com-oasis-term',
          type: 'TERM_LOAN',
          role: 'PRIMARY',
          status: 'ACTIVE',
          openedOn: '2022-01-15',
          limitMinor: 150_000_000n,
          outstandingMinor: 90_000_000n,
          overdueMinor: 4_200_000n,
          daysPastDue: 35,
          history: [0, 30, 62, 31, 0, 35],
        },
        {
          ref: 'com-oasis-trade',
          type: 'TRADE_FINANCE',
          role: 'PRIMARY',
          status: 'ACTIVE',
          openedOn: '2025-04-01',
          limitMinor: 40_000_000n,
          outstandingMinor: 30_000_000n,
          overdueMinor: 0n,
          daysPastDue: 0,
          history: flat(0),
        },
      ],
      bouncedCheques: [{ date: '2026-05-12', amountMinor: 1_500_000n, settled: true }],
      courtCases: [],
      enquiries: [{ date: '2026-12-18', sector: 'FINANCE_COMPANY' }],
    },
    // 11 of 14 paid in November is 78.6%: below the 85% rule for that month.
    wps: { establishmentRef: 'est-demo-oasis', months: wpsYear(14, 9_500_000n, { '2026-11': 11, '2026-12': 13 }) },
    bank: {
      accountKey: 'oasis',
      accountType: 'SME',
      isShariaCompliant: true,
      openingBalanceMinor: 18_000_000n,
      monthly: [
        { kind: 'RENT', day: 1, amountMinor: 1_800_000n, varies: false },
        { kind: 'FINANCE', day: 3, amountMinor: 4_100_000n, varies: false },
        { kind: 'REVENUE', day: 8, amountMinor: 13_000_000n, varies: true },
        { kind: 'SUPPLIER', day: 12, amountMinor: 8_500_000n, varies: true },
        { kind: 'REVENUE', day: 22, amountMinor: 13_000_000n, varies: true },
        { kind: 'PAYROLL', day: 28, amountMinor: 9_500_000n, varies: false },
        { kind: 'CARD_FX', day: 17, amountMinor: 367_250n, varies: false },
      ],
      returnedMonths: ['2026-08', '2026-11'],
    },
  },
  {
    licence: 'SHJ-3003003',
    issuingAuthority: { code: 'SEDD', nameEn: 'Sharjah Economic Development Department' },
    economicRegisterNumber: 'ERN-0003003003',
    trn: '100300300300003',
    nameEn: 'Synthetic Dune Logistics LLC',
    nameAr: 'شركة الكثبان الاصطناعية للخدمات اللوجستية ذ.م.م',
    legalForm: 'llc',
    incorporatedOn: '2024-02-01',
    licenceExpiresOn: '2027-01-31',
    isic4: [{ code: '4923', descriptionEn: 'Freight transport by road' }],
    shareCapitalMinor: 15_000_000n,
    emirate: 'Sharjah',
    parties: [
      {
        ref: 'demo-dune-owner-1',
        displayName: 'Synthetic Owner Dune One',
        displayNameAr: 'مالك الكثبان الاصطناعي الأول',
        officerRole: 'partner',
        ownershipPerTenThousand: 5000,
        naturesOfControl: ['ownership-of-shares-25-to-50-percent', 'voting-rights-25-to-50-percent'],
        nationality: 'Synthetic',
        bureau: {
          found: true,
          score: 702,
          band: 'B',
          reasonCodes: ['R05'],
          contracts: [
            {
              ref: 'ind-dune-1-personal',
              type: 'PERSONAL_LOAN',
              role: 'PRIMARY',
              status: 'ACTIVE',
              openedOn: '2023-09-01',
              limitMinor: 15_000_000n,
              outstandingMinor: 6_200_000n,
              overdueMinor: 0n,
              daysPastDue: 0,
              history: [0, 0, 0, 12, 0, 0],
            },
          ],
          enquiries: [],
          ...CLEAN,
        },
      },
      {
        ref: 'demo-dune-owner-2',
        displayName: 'Synthetic Owner Dune Two',
        displayNameAr: 'مالك الكثبان الاصطناعي الثاني',
        officerRole: 'partner',
        ownershipPerTenThousand: 5000,
        naturesOfControl: ['ownership-of-shares-25-to-50-percent', 'voting-rights-25-to-50-percent'],
        nationality: 'Synthetic',
        bureau: {
          found: true,
          score: 688,
          band: 'B',
          reasonCodes: ['R05', 'R18'],
          contracts: [
            {
              ref: 'ind-dune-2-card-closed',
              type: 'CREDIT_CARD',
              role: 'PRIMARY',
              status: 'SETTLED',
              openedOn: '2018-01-01',
              limitMinor: 2_000_000n,
              outstandingMinor: 0n,
              overdueMinor: 0n,
              daysPastDue: 0,
              history: flat(0),
            },
          ],
          enquiries: [{ date: '2026-09-09', sector: 'BANK' }],
          ...CLEAN,
        },
      },
    ],
    // A business under three years old with no facility yet: the bureau has no file on it.
    bureau: { found: false, reasonCodes: [], contracts: [], enquiries: [], ...CLEAN },
    wps: { establishmentRef: 'est-demo-dune', months: wpsYear(6, 3_800_000n) },
    bank: {
      accountKey: 'dune',
      accountType: 'SME',
      isShariaCompliant: false,
      openingBalanceMinor: 9_000_000n,
      monthly: [
        { kind: 'RENT', day: 1, amountMinor: 900_000n, varies: false },
        { kind: 'REVENUE', day: 9, amountMinor: 6_000_000n, varies: true },
        { kind: 'SUPPLIER', day: 14, amountMinor: 3_100_000n, varies: true },
        { kind: 'REVENUE', day: 24, amountMinor: 6_000_000n, varies: true },
        { kind: 'PAYROLL', day: 28, amountMinor: 3_800_000n, varies: false },
      ],
      returnedMonths: [],
    },
  },
];

/** A synthetic salaried person's personal account, for an Open Finance read of an individual. */
export function personalBank(key: string, salaryMinor: bigint): CastBank {
  return {
    accountKey: key,
    accountType: 'Retail',
    isShariaCompliant: false,
    openingBalanceMinor: 2_500_000n,
    monthly: [
      { kind: 'SPEND', day: 2, amountMinor: (salaryMinor * 35n) / 100n, varies: true },
      { kind: 'SPEND', day: 16, amountMinor: (salaryMinor * 30n) / 100n, varies: true },
      { kind: 'SALARY', day: 26, amountMinor: salaryMinor, varies: false },
    ],
    returnedMonths: [],
  };
}

// -- Lookups -------------------------------------------------------------------

export const castCompany = (licence: string): CastCompany | undefined => CAST.find((c) => c.licence === licence);
export const castCompanyByTrn = (trn: string): CastCompany | undefined => CAST.find((c) => c.trn === trn);
export const castParty = (ref: string): { readonly company: CastCompany; readonly party: CastParty } | undefined => {
  for (const company of CAST) {
    const party = company.parties.find((p) => p.ref === ref);
    if (party !== undefined) return { company, party };
  }
  return undefined;
};

// -- Bank history -------------------------------------------------------------

export interface BankLine {
  readonly id: string;
  /** YYYY-MM-DD, the LFI's own calendar date. */
  readonly date: string;
  readonly kind: BankLineKind | 'RETURNED_CHEQUE';
  readonly direction: 'Credit' | 'Debit';
  readonly status: 'Booked' | 'Rejected';
  readonly amountMinor: bigint;
}

const CREDIT_KINDS: ReadonlySet<BankLineKind> = new Set(['REVENUE', 'SALARY']);
/** As-of day: the as-of month is read only up to the day before the as-of date. */
const AS_OF_DAY = 14;

/**
 * The account's statement from the first history month to the as-of date,
 * oldest first, and its closing booked balance. Deterministic: the same
 * profile always yields the same lines.
 */
export function bankHistory(bank: CastBank): { readonly lines: readonly BankLine[]; readonly closingMinor: bigint } {
  const lines: BankLine[] = [];
  let balance = bank.openingBalanceMinor;
  CAST_HISTORY_MONTHS.forEach((month, m) => {
    const isAsOfMonth = m === CAST_HISTORY_MONTHS.length - 1;
    const patterns = [...bank.monthly].sort((a, b) => a.day - b.day);
    patterns.forEach((pattern, k) => {
      if (isAsOfMonth && pattern.day > AS_OF_DAY) return;
      const variation = pattern.varies ? BigInt(((m * 7 + k * 3) % 11) - 5) : 0n;
      const amountMinor = (pattern.amountMinor * (100n + variation)) / 100n;
      const direction = CREDIT_KINDS.has(pattern.kind) ? 'Credit' : 'Debit';
      balance += direction === 'Credit' ? amountMinor : -amountMinor;
      lines.push({
        id: `${bank.accountKey}-${month}-${String(k + 1).padStart(2, '0')}`,
        date: `${month}-${String(pattern.day).padStart(2, '0')}`,
        kind: pattern.kind,
        direction,
        status: 'Booked',
        amountMinor,
      });
    });
    if (bank.returnedMonths.includes(month))
      lines.push({
        id: `${bank.accountKey}-${month}-rc`,
        date: `${month}-18`,
        kind: 'RETURNED_CHEQUE',
        direction: 'Debit',
        status: 'Rejected',
        amountMinor: 2_250_000n,
      });
  });
  lines.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return { lines, closingMinor: balance };
}
