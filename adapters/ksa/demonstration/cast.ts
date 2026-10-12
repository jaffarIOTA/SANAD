/**
 * The synthetic Saudi cast the KSA demonstration transport answers about.
 *
 * Three companies and four people, deterministic and wholly invented: every
 * display name says it is a demonstration, no identifier is a real one, and
 * the "identity numbers" are not even in a national format (SYNTH-…), so
 * nothing here can be mistaken for, or collide with, a real person or
 * registration. Commercial registration numbers are ten digits (the format
 * the registry port requires); CR national numbers start 700, the unified
 * series. Amounts are the decimal strings the rails speak; the adapters turn
 * them into minor units.
 *
 * Dates that must stay current (zakat certificate validity, the twelve months
 * of bank history) are relative to the transport's clock and generated there,
 * so the demonstration does not age into a different story.
 */

export interface CastFacility {
  readonly facilityType: string;
  readonly status: 'ACTIVE' | 'DELINQUENT' | 'CLOSED' | 'SETTLED' | 'WRITTEN_OFF';
  readonly creditLimit: string;
  readonly outstandingBalance: string;
  readonly overdueAmount: string;
  readonly daysPastDue: number;
  /** Most recent month first: 0 current, 1 = 1–29 days late, 2 = 30–59, … (common bureau convention). */
  readonly paymentHistory: string;
}

export interface CastBureauProfile {
  /** The bureau's opaque score. Its range is not public; these are invented figures with no scale implied. */
  readonly score: number;
  readonly reasonCodes: readonly string[];
  readonly facilities: readonly CastFacility[];
  readonly defaults: readonly { readonly amount: string; readonly settled: boolean; readonly defaultDate: string }[];
  readonly judgments: readonly { readonly caseType: string; readonly amount: string; readonly status: string }[];
  readonly enquiriesLast12Months: number;
}

export interface CastEmployment {
  readonly establishmentNumber: string;
  readonly establishmentName: string;
  readonly joiningDate: string;
  readonly employmentStatus: 'ACTIVE' | 'INACTIVE';
  readonly basicWage: string;
  readonly housingAllowance: string;
  readonly otherAllowances: string;
}

export interface CastBank {
  /** The SAR current account balance at the start of the twelve months of history. */
  readonly openingBalance: string;
  readonly monthlySalary: string;
  readonly monthlyRent: string;
  readonly monthlyBills: string;
  readonly monthlyCardSpend: string;
  /** A loan instalment debit flagged KSAOB.Loan, where the person has one. */
  readonly monthlyLoanInstalment?: string;
  /** How many of the last six months carry a rejected (returned) debit. */
  readonly rejectedDebitsLast6Months: number;
  /** A second account in another currency, which a riyal affordability leaves out. */
  readonly foreignCurrencyAccount?: boolean;
}

export interface CastPerson {
  /** The applicant / party reference every rail is asked about. */
  readonly ref: string;
  readonly displayNameEn: string;
  readonly displayNameAr: string;
  /** Not a national identifier and not in the national format: the rails' "identity number" field in the demonstration. */
  readonly syntheticIdentity: string;
  /** Yakeen-style attributes (SP014 list), all invented. */
  readonly attributes: {
    readonly firstName: string;
    readonly fatherName: string;
    readonly grandFatherName: string;
    readonly familyName: string;
    readonly englishFirstName: string;
    readonly englishSecondName: string;
    readonly englishThirdName: string;
    readonly englishLastName: string;
    readonly gender: 'M' | 'F';
    readonly dateOfBirthH: string;
    readonly dateOfBirthG: string;
    readonly nationalityCode: string;
    readonly idExpiryDateH: string;
  };
  readonly employment: readonly CastEmployment[];
  readonly bureau: CastBureauProfile;
  readonly bank: CastBank;
}

export interface CastCompany {
  readonly crNumber: string;
  readonly crNationalNumber: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly entityType: {
    readonly id: number;
    readonly name: string;
    readonly formId: number;
    readonly formName: string;
  };
  /** Wathq status id: 1 Active is the only published value. */
  readonly statusId: number;
  readonly paidCapital: string;
  readonly issueDateGregorian: string;
  readonly activities: readonly { readonly id: string; readonly name: string }[];
  readonly ownerRefs: readonly string[];
  readonly managerRefs: readonly string[];
  readonly bureau: CastBureauProfile;
  /** Flagged: the company carries an unsettled bureau default. */
  readonly bureauDefault: boolean;
  readonly zakat: { readonly certificateNumber: string; readonly state: 'VALID' | 'EXPIRED' };
  /** The GOSI establishment number its staff are registered under. */
  readonly establishmentNumber: string;
}

const clean = (score: number, facilities: readonly CastFacility[] = []): CastBureauProfile => ({
  score,
  reasonCodes: [],
  facilities,
  defaults: [],
  judgments: [],
  enquiriesLast12Months: 1,
});

const attributes = (n: string, gender: 'M' | 'F', dobH: string, dobG: string) => ({
  firstName: `تجريبي ${n}`,
  fatherName: 'سند',
  grandFatherName: 'عرض',
  familyName: 'المثال',
  englishFirstName: `Demo ${n}`,
  englishSecondName: 'Sanad',
  englishThirdName: 'Display',
  englishLastName: 'Example',
  gender,
  dateOfBirthH: dobH,
  dateOfBirthG: dobG,
  nationalityCode: 'SAU',
  idExpiryDateH: '1452-01-01',
});

export const CAST_PEOPLE: readonly CastPerson[] = [
  {
    ref: 'ksa-demo-person-a',
    displayNameEn: 'Demonstration Person A (synthetic)',
    displayNameAr: 'شخص تجريبي أ (اصطناعي)',
    syntheticIdentity: 'SYNTH-0000000001',
    attributes: attributes('A', 'M', '1405-03-12', '1984-12-05'),
    employment: [
      {
        establishmentNumber: '50000101',
        establishmentName: 'Sanad Demonstration Trading Co.',
        joiningDate: '2016-02-01',
        employmentStatus: 'ACTIVE',
        basicWage: '18000.00',
        housingAllowance: '4500.00',
        otherAllowances: '1500.00',
      },
    ],
    bureau: clean(712, [
      {
        facilityType: 'PERSONAL_FINANCE',
        status: 'ACTIVE',
        creditLimit: '150000.00',
        outstandingBalance: '92000.00',
        overdueAmount: '0.00',
        daysPastDue: 0,
        paymentHistory: '000000000000000000000000',
      },
      {
        facilityType: 'CREDIT_CARD',
        status: 'ACTIVE',
        creditLimit: '30000.00',
        outstandingBalance: '4200.00',
        overdueAmount: '0.00',
        daysPastDue: 0,
        paymentHistory: '000000000000000000000000',
      },
    ]),
    bank: {
      openingBalance: '42000.00',
      monthlySalary: '24000.00',
      monthlyRent: '6500.00',
      monthlyBills: '1200.00',
      monthlyCardSpend: '7300.00',
      monthlyLoanInstalment: '3100.00',
      rejectedDebitsLast6Months: 0,
      foreignCurrencyAccount: true,
    },
  },
  {
    ref: 'ksa-demo-person-b',
    displayNameEn: 'Demonstration Person B (synthetic)',
    displayNameAr: 'شخص تجريبي ب (اصطناعي)',
    syntheticIdentity: 'SYNTH-0000000002',
    attributes: attributes('B', 'F', '1410-07-01', '1990-01-24'),
    employment: [
      {
        establishmentNumber: '50000101',
        establishmentName: 'Sanad Demonstration Trading Co.',
        joiningDate: '2020-09-15',
        employmentStatus: 'ACTIVE',
        basicWage: '11000.00',
        housingAllowance: '2750.00',
        otherAllowances: '800.00',
      },
    ],
    bureau: clean(688),
    bank: {
      openingBalance: '15500.00',
      monthlySalary: '14550.00',
      monthlyRent: '4000.00',
      monthlyBills: '900.00',
      monthlyCardSpend: '6800.00',
      rejectedDebitsLast6Months: 0,
    },
  },
  {
    ref: 'ksa-demo-person-c',
    displayNameEn: 'Demonstration Person C (synthetic)',
    displayNameAr: 'شخص تجريبي ج (اصطناعي)',
    syntheticIdentity: 'SYNTH-0000000003',
    attributes: attributes('C', 'M', '1398-11-20', '1978-10-22'),
    employment: [
      {
        establishmentNumber: '50000202',
        establishmentName: 'Demonstration Contracting Est.',
        joiningDate: '2012-05-01',
        employmentStatus: 'ACTIVE',
        basicWage: '9000.00',
        housingAllowance: '2250.00',
        otherAllowances: '0.00',
      },
      {
        establishmentNumber: '50000999',
        establishmentName: 'Former Demonstration Employer',
        joiningDate: '2008-01-01',
        employmentStatus: 'INACTIVE',
        basicWage: '6000.00',
        housingAllowance: '1500.00',
        otherAllowances: '0.00',
      },
    ],
    bureau: {
      score: 603,
      reasonCodes: ['DEMO-ARREARS-30', 'DEMO-HIGH-UTILISATION'],
      facilities: [
        {
          facilityType: 'AUTO_LEASE',
          status: 'DELINQUENT',
          creditLimit: '120000.00',
          outstandingBalance: '61000.00',
          overdueAmount: '4650.00',
          daysPastDue: 34,
          paymentHistory: '210000100000000000000000',
        },
      ],
      defaults: [{ amount: '2300.00', settled: true, defaultDate: '2021-03-31' }],
      judgments: [],
      enquiriesLast12Months: 4,
    },
    bank: {
      openingBalance: '3800.00',
      monthlySalary: '11250.00',
      monthlyRent: '3500.00',
      monthlyBills: '1100.00',
      monthlyCardSpend: '4400.00',
      monthlyLoanInstalment: '2325.00',
      rejectedDebitsLast6Months: 2,
    },
  },
  {
    ref: 'ksa-demo-person-d',
    displayNameEn: 'Demonstration Person D (synthetic)',
    displayNameAr: 'شخص تجريبي د (اصطناعي)',
    syntheticIdentity: 'SYNTH-0000000004',
    attributes: attributes('D', 'M', '1402-01-15', '1981-11-13'),
    employment: [
      {
        establishmentNumber: '50000303',
        establishmentName: 'Demonstration Logistics Co.',
        joiningDate: '2018-03-01',
        employmentStatus: 'ACTIVE',
        basicWage: '15000.00',
        housingAllowance: '3750.00',
        otherAllowances: '1000.00',
      },
    ],
    bureau: {
      score: 541,
      reasonCodes: ['DEMO-DEFAULT-RECORDED'],
      facilities: [
        {
          facilityType: 'PERSONAL_FINANCE',
          status: 'WRITTEN_OFF',
          creditLimit: '80000.00',
          outstandingBalance: '0.00',
          overdueAmount: '18500.00',
          daysPastDue: 180,
          paymentHistory: '666654321000000000000000',
        },
      ],
      defaults: [{ amount: '18500.00', settled: false, defaultDate: '2025-06-30' }],
      judgments: [{ caseType: 'ENFORCEMENT', amount: '18500.00', status: 'OPEN' }],
      enquiriesLast12Months: 6,
    },
    bank: {
      openingBalance: '9000.00',
      monthlySalary: '19750.00',
      monthlyRent: '5500.00',
      monthlyBills: '1300.00',
      monthlyCardSpend: '11800.00',
      rejectedDebitsLast6Months: 1,
    },
  },
];

export const CAST_COMPANIES: readonly CastCompany[] = [
  {
    crNumber: '1010000101',
    crNationalNumber: '7000000101',
    nameAr: 'شركة سند التجريبية للتجارة',
    nameEn: 'Sanad Demonstration Trading Co.',
    entityType: { id: 2, name: 'شركة', formId: 201, formName: 'Limited Liability Company' },
    statusId: 1,
    paidCapital: '500000.00',
    issueDateGregorian: '2014-06-01',
    activities: [
      { id: '464111', name: 'Wholesale of textiles (demonstration)' },
      { id: '469000', name: 'Non-specialised wholesale trade (demonstration)' },
    ],
    ownerRefs: ['ksa-demo-person-a'],
    managerRefs: ['ksa-demo-person-a', 'ksa-demo-person-b'],
    bureau: clean(705, [
      {
        facilityType: 'WORKING_CAPITAL',
        status: 'ACTIVE',
        creditLimit: '2000000.00',
        outstandingBalance: '850000.00',
        overdueAmount: '0.00',
        daysPastDue: 0,
        paymentHistory: '000000000000000000000000',
      },
    ]),
    bureauDefault: false,
    zakat: { certificateNumber: 'ZC-DEMO-0000101', state: 'VALID' },
    establishmentNumber: '50000101',
  },
  {
    crNumber: '4030000202',
    crNationalNumber: '7000000202',
    nameAr: 'مؤسسة المقاولات التجريبية',
    nameEn: 'Demonstration Contracting Est.',
    entityType: { id: 1, name: 'مؤسسة', formId: 101, formName: 'Sole Proprietorship' },
    statusId: 1,
    paidCapital: '100000.00',
    issueDateGregorian: '2011-09-20',
    activities: [{ id: '410010', name: 'General construction of buildings (demonstration)' }],
    ownerRefs: ['ksa-demo-person-c'],
    managerRefs: ['ksa-demo-person-c'],
    bureau: {
      score: 590,
      reasonCodes: ['DEMO-ARREARS-30'],
      facilities: [
        {
          facilityType: 'TERM_FINANCE',
          status: 'DELINQUENT',
          creditLimit: '750000.00',
          outstandingBalance: '410000.00',
          overdueAmount: '36000.00',
          daysPastDue: 41,
          paymentHistory: '221000000000000000000000',
        },
      ],
      defaults: [],
      judgments: [],
      enquiriesLast12Months: 3,
    },
    bureauDefault: false,
    zakat: { certificateNumber: 'ZC-DEMO-0000202', state: 'EXPIRED' },
    establishmentNumber: '50000202',
  },
  {
    crNumber: '2050000303',
    crNationalNumber: '7000000303',
    nameAr: 'شركة الخدمات اللوجستية التجريبية',
    nameEn: 'Demonstration Logistics Co.',
    entityType: { id: 2, name: 'شركة', formId: 202, formName: 'Simplified Joint Stock Company' },
    statusId: 1,
    paidCapital: '1250000.00',
    issueDateGregorian: '2017-12-10',
    activities: [{ id: '492300', name: 'Freight transport by road (demonstration)' }],
    ownerRefs: ['ksa-demo-person-d', 'ksa-demo-person-a'],
    managerRefs: ['ksa-demo-person-d'],
    bureau: {
      score: 522,
      reasonCodes: ['DEMO-DEFAULT-RECORDED'],
      facilities: [
        {
          facilityType: 'WORKING_CAPITAL',
          status: 'ACTIVE',
          creditLimit: '1500000.00',
          outstandingBalance: '1320000.00',
          overdueAmount: '95000.00',
          daysPastDue: 62,
          paymentHistory: '322100000000000000000000',
        },
      ],
      defaults: [{ amount: '240000.00', settled: false, defaultDate: '2026-02-28' }],
      judgments: [],
      enquiriesLast12Months: 7,
    },
    bureauDefault: true,
    zakat: { certificateNumber: 'ZC-DEMO-0000303', state: 'VALID' },
    establishmentNumber: '50000303',
  },
];

export const castPerson = (ref: string): CastPerson | undefined => CAST_PEOPLE.find((p) => p.ref === ref);
/** A cast company by either of its numbers. */
export const castCompany = (cr: string): CastCompany | undefined =>
  CAST_COMPANIES.find((c) => c.crNumber === cr || c.crNationalNumber === cr);
