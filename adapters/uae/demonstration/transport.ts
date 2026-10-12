/**
 * The demonstration transport for the UAE rails.
 *
 * A fixture transport that answers by rule instead of from a recorded list, so
 * an officer can walk a whole application on the hosted synthetic environment
 * and see every outcome a real register, bureau, authority or bank can give.
 * It answers EVERY operation the UAE adapters make, in each adapter's assumed
 * contract — the public analogue that adapter's README names (Companies House
 * for NER, UAE Pass attribute names for ICP, a standard bureau report for
 * AECB, VIES for FTA, the WPS SIF for MOHRE, docs.uaepass.ae for UAE Pass,
 * ISO 20022 for the partner bank, and the published CBUAE Open Finance v2.1
 * OpenAPI for Open Finance) — so the adapters' mapping, consent checks and
 * typed outcomes run exactly as they will against the live rail; only the
 * answer is invented.
 *
 * It is selected only where a synthetic demonstration is permitted (the
 * process declares synthetic data and the database confirms it, SR-005);
 * everywhere else the rails are live or unavailable. Every answer it gives is
 * labelled FIXTURE wherever it is shown.
 *
 * WHO ANSWERS. A trade licence, TRN or party reference from the cast
 * (cast.ts) answers from the cast, consistently across every rail. Anything
 * else answers by these rules, so a demonstration can be steered from a form:
 *
 *   licence   UNK-    not on the register (HTTP 404), no bureau file, not VAT-registered
 *             EXP-    register status expired
 *             SUS-    register status suspended
 *             DEF-    bureau: a written-off facility and an unpaid bounced cheque, score 412
 *             LATE-   WPS: the latest month paid 7 of 10 employees (below the 85% rule)
 *             DEREG-  VAT deregistered
 *             other   active, clean bureau file (score 705), VAT-registered
 *   TRN       9…      (fifteen digits starting 9) not VAT-registered
 *   party     mismatch    identity does not match (name)
 *             expired     identity matches an expired card
 *             default     individual bureau: a defaulted personal loan
 *             nohit       individual bureau: no file
 *             unemployed  WPS: employment terminated
 *             basic       UAE Pass account at SOP1 (may log in, may not step up or sign)
 *             reject      UAE Pass: the person declines (access_denied / signer canceled)
 *             pending     UAE Pass: not yet completed
 *             fail        UAE Pass signing: failed
 *   payment   reference containing reject → RJCT (AC04), pending → PDNG,
 *             settled → ACSC; a collection containing return → returned (AM04);
 *             otherwise a disbursement is ACSP and a collection ACSC
 *   consent   (Open Finance) an id containing a cast licence or party reference
 *             reads that subject's accounts; containing revoked / expired /
 *             awaiting → that consent status; otherwise a generic SME account
 *
 * The cast's answers are as of 2027-01-15 (CAST_AS_OF_ISO). UAE Pass and
 * payment times use the clock the transport is given, because an
 * authentication must be fresh against the adapter's own clock.
 */

import { money } from '../../../core/kernel/money.ts';
import { type RailEnvelope, type RailTransport, TransportError } from '../../kernel/http-transport.ts';
import { aedDecimal } from '../kernel/dirham.ts';
import {
  type BankLine,
  type CastBank,
  type CastBureau,
  type CastCompany,
  CAST,
  CAST_AS_OF_EPOCH,
  CAST_AS_OF_ISO,
  CAST_HISTORY_MONTHS,
  bankHistory,
  castCompany,
  castCompanyByTrn,
  castParty,
  personalBank,
} from './cast.ts';

type Answer = Readonly<Record<string, unknown>>;
type Rule = (e: RailEnvelope, now: number) => Answer;

/** AED minor units → the decimal string every rail answers in. */
const dec = (minor: bigint): string => aedDecimal(money(minor, 'AED'));
const iso = (epoch: number): string => new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');
const url = (e: RailEnvelope): URL => new URL(e.url);
/** Path segments after the base, decoded. */
const segments = (e: RailEnvelope): string[] =>
  url(e)
    .pathname.split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
const body = (e: RailEnvelope, key: string): string => {
  const v = e.body?.[key];
  return typeof v === 'string' ? v : '';
};
const notFound = (operation: string): never => {
  throw new TransportError(operation, 404, 'not found');
};
const has = (s: string, word: string): boolean => s.toLowerCase().includes(word);
/** "YYYY-MM" → the SIF salary month "MMYYYY". */
const sifMonth = (month: string): string => `${month.slice(5, 7)}${month.slice(0, 4)}`;
/** A synthetic Emirates ID in the published layout; never a real one (the 0000 year cannot be a birth year). */
const syntheticIdn = (ref: string): string => {
  let n = 0;
  for (const ch of ref) n = (n * 31 + ch.charCodeAt(0)) % 10_000_000;
  return `784-0000-${String(n).padStart(7, '0')}-0`;
};

// -- NER (Companies House analogue) -------------------------------------------

function genericCompany(licence: string): CastCompany {
  return {
    licence,
    issuingAuthority: { code: 'DET', nameEn: 'Dubai Department of Economy and Tourism' },
    economicRegisterNumber: `ERN-DEMO-${licence}`,
    trn: '100999999999993',
    nameEn: 'Demonstration Trading LLC',
    nameAr: 'شركة العرض التجريبي',
    legalForm: 'llc',
    incorporatedOn: '2019-04-01',
    licenceExpiresOn: '2027-12-31',
    isic4: [{ code: '4690', descriptionEn: 'Non-specialized wholesale trade' }],
    shareCapitalMinor: 30_000_000n,
    emirate: 'Dubai',
    parties: [],
    bureau: {
      found: true,
      score: 705,
      band: 'B',
      reasonCodes: ['C05'],
      contracts: [],
      bouncedCheques: [],
      courtCases: [],
      enquiries: [],
    },
    wps: { establishmentRef: `est-demo-${licence}`, months: [] },
    bank: GENERIC_SME_BANK,
  };
}

function registryProfile(e: RailEnvelope): Answer {
  const licence = segments(e)[1] ?? '';
  if (licence.startsWith('UNK-')) notFound('registry.lookup');
  const c = castCompany(licence) ?? genericCompany(licence);
  const status = licence.startsWith('EXP-') ? 'expired' : licence.startsWith('SUS-') ? 'suspended' : 'active';
  return {
    company_name: c.nameEn,
    company_name_ar: c.nameAr,
    company_number: licence,
    company_status: status,
    type: c.legalForm,
    date_of_creation: c.incorporatedOn,
    licence_expiry_date: licence.startsWith('EXP-') ? '2026-06-30' : c.licenceExpiresOn,
    economic_register_number: c.economicRegisterNumber,
    issuing_authority: { code: c.issuingAuthority.code, name_en: c.issuingAuthority.nameEn },
    isic4_activities: c.isic4.map((a) => ({ code: a.code, description_en: a.descriptionEn })),
    share_capital: { amount: dec(c.shareCapitalMinor), currency: 'AED' },
    registered_office_address: {
      address_line_1: 'Synthetic Business Centre',
      locality: c.emirate,
      country: 'United Arab Emirates',
    },
    jurisdiction: c.emirate.toLowerCase().replace(' ', '-'),
    has_charges: c.bureau.contracts.length > 0,
    etag: `ner-demo-${licence}`,
    links: {
      self: `/company/${licence}`,
      officers: `/company/${licence}/officers`,
      persons_with_significant_control: `/company/${licence}/persons-with-significant-control`,
    },
  };
}

function registryOfficers(e: RailEnvelope): Answer {
  const licence = segments(e)[1] ?? '';
  if (licence.startsWith('UNK-')) notFound('registry.officers');
  const c = castCompany(licence);
  const officers = c
    ? c.parties.flatMap((p) =>
        p.officerRole === undefined
          ? []
          : [
              {
                ref: p.ref,
                name: p.displayName.toUpperCase(),
                role: p.officerRole,
                nationality: p.nationality,
                from: c.incorporatedOn,
              },
            ],
      )
    : [
        {
          ref: `demo-manager-${licence}`,
          name: 'DEMONSTRATION MANAGER',
          role: 'manager',
          nationality: 'Synthetic',
          from: '2019-04-01',
        },
      ];
  return {
    kind: 'officer-list',
    active_count: officers.length,
    resigned_count: 0,
    total_results: officers.length,
    items: officers.map((o) => ({
      name: o.name,
      officer_role: o.role,
      appointed_on: o.from,
      nationality: o.nationality,
      identification: { identification_type: 'emirates-id', registration_number: syntheticIdn(o.ref) },
      links: { officer: { appointments: `/officers/${o.ref}/appointments` } },
    })),
    links: { self: `/company/${licence}/officers` },
  };
}

function registryControllers(e: RailEnvelope): Answer {
  const licence = segments(e)[1] ?? '';
  if (licence.startsWith('UNK-')) notFound('registry.psc');
  const c = castCompany(licence);
  const owners = c
    ? c.parties.filter((p) => p.ownershipPerTenThousand > 0)
    : [
        {
          ref: `demo-owner-${licence}`,
          displayName: 'Demonstration Owner',
          naturesOfControl: ['ownership-of-shares-75-to-100-percent'],
          nationality: 'Synthetic',
        },
      ];
  return {
    active_count: owners.length,
    ceased_count: 0,
    total_results: owners.length,
    items: owners.map((p) => ({
      kind: 'individual-person-with-significant-control',
      name: p.displayName.toUpperCase(),
      natures_of_control: p.naturesOfControl,
      notified_on: c?.incorporatedOn ?? '2019-04-01',
      nationality: p.nationality,
      country_of_residence: 'United Arab Emirates',
      identification: { identification_type: 'emirates-id', registration_number: syntheticIdn(p.ref) },
      links: { self: `/company/${licence}/persons-with-significant-control/individual/${p.ref}` },
    })),
    links: { self: `/company/${licence}/persons-with-significant-control` },
  };
}

// -- ICP (UAE Pass attribute names) -------------------------------------------

function identity(e: RailEnvelope): Answer {
  const ref = body(e, 'applicantRef');
  const cast = castParty(ref);
  const match = has(ref, 'mismatch') ? 'NO_MATCH' : 'MATCH';
  const name = cast?.party.displayName ?? 'Demonstration Person';
  return {
    verification: {
      reference: `icp-demo-${ref}`,
      verified_at: CAST_AS_OF_ISO,
      outcome: match,
      mismatched_attributes: match === 'MATCH' ? [] : ['fullnameEN'],
    },
    card: { idType: 'ID', status: has(ref, 'expired') ? 'EXPIRED' : 'VALID', expiryDate: '2029-05-31' },
    subject: {
      idn: syntheticIdn(ref),
      fullnameEN: name,
      fullnameAR: cast?.party.displayNameAr ?? 'شخص تجريبي',
      nationalityEN: cast?.party.nationality ?? 'Synthetic',
      gender: 'Male',
      userType: 'SOP3',
    },
  };
}

// -- AECB (standard bureau report layout) -------------------------------------

const HISTORY_PERIODS = CAST_HISTORY_MONTHS.slice(6, 12);
const GENERIC_INDIVIDUAL: CastBureau = {
  found: true,
  score: 712,
  band: 'B',
  reasonCodes: ['R07'],
  contracts: [
    {
      ref: 'ind-demo-card',
      type: 'CREDIT_CARD',
      role: 'PRIMARY',
      status: 'ACTIVE',
      openedOn: '2020-01-01',
      limitMinor: 3_000_000n,
      outstandingMinor: 450_000n,
      overdueMinor: 0n,
      daysPastDue: 0,
      history: [0, 0, 0, 0, 0, 0],
    },
  ],
  bouncedCheques: [],
  courtCases: [],
  enquiries: [],
};
const DEFAULTED = (personal: boolean): CastBureau => ({
  found: true,
  score: 412,
  band: 'E',
  reasonCodes: ['C90', 'C91'],
  contracts: [
    {
      ref: personal ? 'ind-demo-default' : 'com-demo-default',
      type: personal ? 'PERSONAL_LOAN' : 'TERM_LOAN',
      role: 'PRIMARY',
      status: personal ? 'DEFAULTED' : 'WRITTEN_OFF',
      openedOn: '2021-03-01',
      limitMinor: personal ? 8_000_000n : 60_000_000n,
      outstandingMinor: personal ? 5_400_000n : 41_000_000n,
      overdueMinor: personal ? 5_400_000n : 41_000_000n,
      daysPastDue: 180,
      history: [90, 120, 150, 180, 180, 180],
    },
  ],
  bouncedCheques: personal ? [] : [{ date: '2026-09-03', amountMinor: 2_750_000n, settled: false }],
  courtCases: personal ? [] : [{ ref: 'case-demo-1', status: 'OPEN', claimMinor: 41_000_000n }],
  enquiries: [{ date: '2026-12-01', sector: 'BANK' }],
});
const NO_FILE: CastBureau = {
  found: false,
  reasonCodes: [],
  contracts: [],
  bouncedCheques: [],
  courtCases: [],
  enquiries: [],
};

function bureauReport(reference: string, product: string, b: CastBureau, subject: Answer): Answer {
  const report = { reference, generated_at: CAST_AS_OF_ISO, product, subject_found: b.found };
  if (!b.found) return { report };
  return {
    report,
    subject,
    ...(b.score === undefined
      ? {}
      : {
          score: {
            value: b.score,
            range_min: 300,
            range_max: 900,
            band: b.band,
            reason_codes: b.reasonCodes.map((code) => ({ code })),
          },
        }),
    contracts: b.contracts.map((c) => ({
      contract_ref: c.ref,
      type: c.type,
      role: c.role,
      status: c.status,
      opened_on: c.openedOn,
      credit_limit: { amount: dec(c.limitMinor), currency: 'AED' },
      outstanding_balance: { amount: dec(c.outstandingMinor), currency: 'AED' },
      overdue_amount: { amount: dec(c.overdueMinor), currency: 'AED' },
      days_past_due: c.daysPastDue,
      payment_history: c.history.map((d, i) => ({ period: HISTORY_PERIODS[i], days_past_due: d })),
    })),
    enquiries: b.enquiries.map((q) => ({ date: q.date, sector: q.sector, purpose: 'NEW_CREDIT_APPLICATION' })),
    public_records: {
      court_cases: b.courtCases.map((k) => ({
        case_ref: k.ref,
        status: k.status,
        claim_amount: { amount: dec(k.claimMinor), currency: 'AED' },
      })),
      bounced_cheques: b.bouncedCheques.map((q) => ({
        cheque_date: q.date,
        amount: { amount: dec(q.amountMinor), currency: 'AED' },
        settled: q.settled,
      })),
    },
  };
}

function bureauCommercial(e: RailEnvelope): Answer {
  const licence = body(e, 'tradeLicenceNumber');
  const c = castCompany(licence);
  const b =
    c?.bureau ??
    (licence.startsWith('UNK-')
      ? NO_FILE
      : licence.startsWith('DEF-')
        ? DEFAULTED(false)
        : genericCompany(licence).bureau);
  return bureauReport(`aecb-demo-c-${licence}`, 'COMMERCIAL_CREDIT_REPORT', b, {
    trade_name: c?.nameEn ?? 'Demonstration Trading LLC',
    trade_licence_number: licence,
    issuing_authority: c?.issuingAuthority.code ?? 'DET',
  });
}

function bureauIndividual(e: RailEnvelope): Answer {
  const ref = body(e, 'applicantRef');
  const cast = castParty(ref);
  const b =
    cast?.party.bureau ?? (has(ref, 'nohit') ? NO_FILE : has(ref, 'default') ? DEFAULTED(true) : GENERIC_INDIVIDUAL);
  return bureauReport(`aecb-demo-i-${ref}`, 'INDIVIDUAL_CREDIT_REPORT', b, {
    full_name: cast?.party.displayName ?? 'Demonstration Person',
    emirates_id: syntheticIdn(ref),
    nationality: 'Synthetic',
  });
}

const bureauSubmission = (e: RailEnvelope): Answer => ({ submissionId: `aecb-demo-ack-${body(e, 'idempotencyKey')}` });

// -- FTA (VIES analogue) ------------------------------------------------------

function taxRegistration(e: RailEnvelope): Answer {
  const u = url(e);
  const trnKey = segments(e).at(-1) ?? '';
  const byTrn = /^\d{15}$/.test(trnKey);
  const licence = u.searchParams.get('licence') ?? '';
  const company = byTrn ? castCompanyByTrn(trnKey) : castCompany(licence);
  const requestIdentifier = `fta-demo-${byTrn ? trnKey : licence}`;
  const base = { requestDate: CAST_AS_OF_ISO, requestIdentifier };
  if (company !== undefined)
    return {
      ...base,
      isValid: true,
      userError: 'VALID',
      vatNumber: company.trn,
      name: company.nameEn,
      nameAr: company.nameAr,
      address: `Synthetic Business Centre, ${company.emirate}`,
    };
  if ((byTrn && trnKey.startsWith('9')) || licence.startsWith('UNK-'))
    return { ...base, isValid: false, userError: 'INVALID' };
  if (licence.startsWith('DEREG-'))
    return { ...base, isValid: false, userError: 'DEREGISTERED', vatNumber: '100888888888883' };
  return {
    ...base,
    isValid: true,
    userError: 'VALID',
    vatNumber: byTrn ? trnKey : '100999999999993',
    name: 'Demonstration Trading LLC',
    address: 'Synthetic Business Centre, Dubai',
  };
}

// -- MOHRE / WPS (SIF records) ------------------------------------------------

function wpsEmployee(e: RailEnvelope): Answer {
  const ref = body(e, 'applicantRef');
  const cast = castParty(ref);
  // An owner who is not on the payroll has no WPS record.
  if (cast !== undefined && cast.party.salary === undefined) notFound('employment.wps');
  const salary = cast?.party.salary ?? {
    employerLicence: 'DEMO-GENERIC',
    since: '2021-06-01',
    fixedMinor: 2_500_000n,
    variableMinor: 200_000n,
  };
  const employer = castCompany(salary.employerLicence);
  const months =
    employer?.wps.months ??
    CAST_HISTORY_MONTHS.slice(0, 12).map((month) => ({
      month,
      employeesDue: 10,
      employeesPaid: 10,
      totalMinor: 25_000_000n,
    }));
  const terminated = has(ref, 'unemployed');
  return {
    report: { reference: `wps-demo-${ref}`, generated_at: CAST_AS_OF_ISO },
    employee: {
      employment_status: terminated ? 'TERMINATED' : 'ACTIVE',
      establishment_ref: employer?.wps.establishmentRef ?? 'est-demo-generic',
      contract_start_date: salary.since,
      person_id: '10000000000001',
      labour_card_number: 'LC-SYNTHETIC-0001',
    },
    salary_records: terminated
      ? []
      : months.map((m) => ({
          scr: {
            record_type: 'SCR',
            employer_id: '1000000000001',
            salary_month: sifMonth(m.month),
            edr_count: m.employeesPaid,
            total_salary: dec(m.totalMinor),
            currency: 'AED',
          },
          edr: {
            record_type: 'EDR',
            routing_code: '000000000',
            iban: 'AE000000000000000000000',
            pay_start_date: `${m.month}-01`,
            pay_end_date: `${m.month}-28`,
            days_in_period: 28,
            fixed_income: dec(salary.fixedMinor),
            variable_income: dec(salary.variableMinor),
            days_on_leave: 0,
          },
        })),
  };
}

function wpsEstablishment(e: RailEnvelope): Answer {
  const licence = body(e, 'tradeLicenceNumber');
  if (licence.startsWith('UNK-')) notFound('employment.wps.establishment');
  const c = castCompany(licence);
  const late = licence.startsWith('LATE-');
  const months =
    c?.wps.months ??
    CAST_HISTORY_MONTHS.slice(0, 12).map((month, i) => ({
      month,
      employeesDue: 10,
      employeesPaid: late && i === 11 ? 7 : 10,
      totalMinor: late && i === 11 ? 17_500_000n : 25_000_000n,
    }));
  return {
    report: { reference: `wps-demo-est-${licence}`, generated_at: CAST_AS_OF_ISO },
    establishment: {
      establishment_ref: c?.wps.establishmentRef ?? `est-demo-${licence}`,
      employer_id: '1000000000001',
    },
    salary_control_records: months.map((m) => ({
      record_type: 'SCR',
      salary_month: sifMonth(m.month),
      employees_due: m.employeesDue,
      edr_count: m.employeesPaid,
      total_salary: dec(m.totalMinor),
      currency: 'AED',
    })),
  };
}

// -- UAE Pass (docs.uaepass.ae) -----------------------------------------------

const UAEPASS_STATE = 'uaepass-demo-';

function authorize(e: RailEnvelope): Answer {
  return { state: `${UAEPASS_STATE}${body(e, 'state')}`, expires_in: 300 };
}

const userType = (ref: string): string => (has(ref, 'basic') ? 'SOP1' : 'SOP3');

function userinfo(e: RailEnvelope, now: number): Answer {
  const state = url(e).searchParams.get('state') ?? '';
  const ref = state.startsWith(UAEPASS_STATE) ? state.slice(UAEPASS_STATE.length) : state;
  if (has(ref, 'reject')) return { error: 'access_denied' };
  if (has(ref, 'pending')) return { error: 'authorization_pending' };
  const cast = castParty(ref);
  const sub = `uaepass-demo-sub-${ref}`;
  const level = userType(ref);
  return {
    id_token: {
      sub,
      jti: `uaepass-demo-jti-${ref}-${String(now)}`,
      auth_time: now,
      acr: 'urn:safelayer:tws:policies:authentication:level:low',
    },
    userinfo: {
      sub,
      uuid: `uaepass-demo-uuid-${ref}`,
      userType: level,
      ...(level === 'SOP1' ? {} : { idn: syntheticIdn(ref) }),
      fullnameEN: cast?.party.displayName ?? 'Demonstration Person',
      fullnameAR: cast?.party.displayNameAr ?? 'شخص تجريبي',
      nationalityEN: 'Synthetic',
      gender: 'Male',
      idType: 'ID',
      mobile: '971500000000',
      email: 'synthetic@demonstration.invalid',
    },
  };
}

function signerStart(e: RailEnvelope): Answer {
  const id = `sp-demo-${body(e, 'state')}`;
  return {
    id,
    status: 'active',
    tasks: {
      pending: [
        {
          id: `${id}-task-1`,
          type: 'urn:safelayer:eidas:sign:identity:use:server',
          url: `https://demonstration.invalid/sign/${id}`,
        },
      ],
    },
  };
}

function signerResult(e: RailEnvelope, now: number): Answer {
  const id = segments(e).at(-1) ?? '';
  const ref = id.startsWith('sp-demo-') ? id.slice('sp-demo-'.length) : id;
  const status = has(ref, 'reject')
    ? 'canceled'
    : has(ref, 'fail')
      ? 'failed'
      : has(ref, 'pending')
        ? 'active'
        : 'finished';
  return {
    id,
    status,
    ...(status === 'finished'
      ? { finished_at: iso(now), signer: { sub: `uaepass-demo-sub-${ref}`, userType: userType(ref) } }
      : {}),
  };
}

// -- Partner bank (ISO 20022 status report) -----------------------------------

function paymentStatus(collection: boolean): Rule {
  return (e, now) => {
    const pmtId = (e.body?.['PmtId'] ?? {}) as Readonly<Record<string, unknown>>;
    const instrId = typeof pmtId['InstrId'] === 'string' ? pmtId['InstrId'] : '';
    const reference = typeof pmtId['EndToEndId'] === 'string' ? pmtId['EndToEndId'] : '';
    const sts = has(reference, 'reject')
      ? 'RJCT'
      : has(reference, 'pending')
        ? 'PDNG'
        : has(reference, 'settled') || collection
          ? 'ACSC'
          : 'ACSP';
    return {
      GrpHdr: { MsgId: `pb-demo-msg-${instrId}`, CreDtTm: iso(now) },
      TxInfAndSts: {
        OrgnlInstrId: instrId,
        OrgnlEndToEndId: reference,
        TxSts: sts,
        ...(sts === 'RJCT' ? { StsRsnInf: { Rsn: { Cd: 'AC04' } } } : {}),
        ...(collection && has(reference, 'return') ? { RtrInf: { RtrRsn: { Cd: 'AM04' } } } : {}),
        AccptncDtTm: iso(now),
        AcctSvcrRef: `pb-demo-${instrId}`,
      },
    };
  };
}

// -- Open Finance (CBUAE v2.1, published) -------------------------------------

const GENERIC_SME_BANK: CastBank = {
  accountKey: 'generic',
  accountType: 'SME',
  isShariaCompliant: false,
  openingBalanceMinor: 12_000_000n,
  monthly: [
    { kind: 'RENT', day: 1, amountMinor: 1_500_000n, varies: false },
    { kind: 'REVENUE', day: 10, amountMinor: 10_000_000n, varies: true },
    { kind: 'SUPPLIER', day: 15, amountMinor: 5_500_000n, varies: true },
    { kind: 'REVENUE', day: 20, amountMinor: 10_000_000n, varies: true },
    { kind: 'PAYROLL', day: 27, amountMinor: 11_000_000n, varies: false },
  ],
  returnedMonths: [],
};

interface OfSubject {
  readonly key: string;
  readonly holder: string;
  readonly bank: CastBank;
  /** A second account in another currency, which affordability must leave out. */
  readonly foreignAccount: boolean;
}

/** Whose data a consent opens: a cast licence or party named in the consent id, else the generic SME. */
function ofSubject(consentId: string): OfSubject {
  for (const c of CAST) {
    if (consentId.includes(c.licence))
      return { key: c.bank.accountKey, holder: c.nameEn, bank: c.bank, foreignAccount: c.bank.accountKey === 'falcon' };
    for (const p of c.parties)
      if (consentId.includes(p.ref))
        return {
          key: p.ref,
          holder: p.displayName,
          bank: personalBank(p.ref, p.salary === undefined ? 3_000_000n : p.salary.fixedMinor + p.salary.variableMinor),
          foreignAccount: false,
        };
  }
  return { key: 'generic', holder: 'Demonstration Trading LLC', bank: GENERIC_SME_BANK, foreignAccount: false };
}

const consentOf = (e: RailEnvelope): string => e.headers['x-sanad-consent-id'] ?? '';
const links = (e: RailEnvelope): Answer => ({ Self: e.url });

function ofConsent(e: RailEnvelope): Answer {
  const id = segments(e).at(-1) ?? '';
  const status = has(id, 'revoked')
    ? 'Revoked'
    : has(id, 'expired')
      ? 'Expired'
      : has(id, 'awaiting')
        ? 'AwaitingAuthorization'
        : 'Authorized';
  const retail = ofSubject(id).bank.accountType === 'Retail';
  return {
    Data: {
      ConsentId: id,
      CreationDateTime: '2027-01-14T09:00:00+04:00',
      Status: status,
      StatusUpdateDateTime: '2027-01-14T09:02:00+04:00',
      Permissions: [
        'ReadAccountsBasic',
        'ReadAccountsDetail',
        'ReadBalances',
        'ReadTransactionsBasic',
        'ReadTransactionsDetail',
      ],
      ExpirationDateTime: '2027-04-14T09:00:00+04:00',
      FromDate: '2026-01-01',
      AccountType: [retail ? 'Retail' : 'SME'],
      AccountSubType: ['CurrentAccount', 'Savings'],
      OpenFinanceBilling: { UserType: retail ? 'Retail' : 'SME', Purpose: 'RiskAssessment' },
    },
    Links: links(e),
    Meta: {},
  };
}

function ofAccounts(e: RailEnvelope): Answer {
  const s = ofSubject(consentOf(e));
  const account = (id: string, currency: string, subType: string) => ({
    AccountId: id,
    AccountHolderName: s.holder,
    Status: 'Active',
    StatusUpdateDateTime: '2026-01-01T00:00:00+04:00',
    Currency: currency,
    AccountType: s.bank.accountType,
    AccountSubType: subType,
    Nickname: `Synthetic ${currency} ${subType}`,
    OpeningDate: '2019-01-01',
    IsShariaCompliant: s.bank.isShariaCompliant,
  });
  return {
    Data: {
      Account: [
        account(`acc-demo-${s.key}`, 'AED', 'CurrentAccount'),
        ...(s.foreignAccount ? [account(`acc-demo-${s.key}-usd`, 'USD', 'Savings')] : []),
      ],
    },
    Links: links(e),
    Meta: { TotalPages: 1 },
  };
}

function ofBalances(e: RailEnvelope): Answer {
  const accountId = segments(e).at(-2) ?? '';
  const { closingMinor } = bankHistory(ofSubject(consentOf(e)).bank);
  const balance = (type: string) => ({
    CreditDebitIndicator: closingMinor < 0n ? 'Debit' : 'Credit',
    Type: type,
    DateTime: CAST_AS_OF_ISO,
    Amount: { Amount: dec(closingMinor < 0n ? -closingMinor : closingMinor), Currency: 'AED' },
  });
  return {
    Data: { AccountId: accountId, Balance: [balance('ClosingAvailable'), balance('ClosingBooked')] },
    Links: links(e),
    Meta: { TotalPages: 1 },
  };
}

const OF_LINE: Readonly<
  Record<BankLine['kind'], { type: string; sub: string; flags: readonly string[]; text: string }>
> = {
  REVENUE: { type: 'LocalBankTransfer', sub: 'MoneyTransfer', flags: [], text: 'Customer payment' },
  PAYROLL: { type: 'LocalBankTransfer', sub: 'MoneyTransfer', flags: ['Payroll'], text: 'WPS salary transfer' },
  RENT: { type: 'LocalBankTransfer', sub: 'MoneyTransfer', flags: ['StandingOrder'], text: 'Warehouse rent' },
  SUPPLIER: { type: 'LocalBankTransfer', sub: 'MoneyTransfer', flags: [], text: 'Supplier payment' },
  FINANCE: {
    type: 'SameBankTransfer',
    sub: 'Repayments',
    flags: ['Finance', 'DirectDebit'],
    text: 'Facility instalment',
  },
  SALARY: { type: 'LocalBankTransfer', sub: 'Deposit', flags: ['Payroll'], text: 'Salary' },
  SPEND: { type: 'POS', sub: 'Purchase', flags: [], text: 'Card purchase' },
  CARD_FX: { type: 'ECommerce', sub: 'Purchase', flags: [], text: 'Online subscription (USD)' },
  RETURNED_CHEQUE: { type: 'Cheque', sub: 'NotApplicable', flags: [], text: 'Cheque returned unpaid' },
};
const OF_PAGE_SIZE = 50;

function ofTransactions(e: RailEnvelope): Answer {
  const u = url(e);
  const accountId = segments(e).at(-2) ?? '';
  const from = (u.searchParams.get('fromBookingDateTime') ?? '0000-00-00').slice(0, 10);
  const to = (u.searchParams.get('toBookingDateTime') ?? '9999-99-99').slice(0, 10);
  const page = Number(u.searchParams.get('page') ?? '1');
  const lines = bankHistory(ofSubject(consentOf(e)).bank).lines.filter((l) => l.date >= from && l.date <= to);
  const pages = Math.max(1, Math.ceil(lines.length / OF_PAGE_SIZE));
  const next = new URL(u);
  next.searchParams.set('page', String(page + 1));
  return {
    Data: {
      AccountId: accountId,
      Transaction: lines.slice((page - 1) * OF_PAGE_SIZE, page * OF_PAGE_SIZE).map((l) => {
        const shape = OF_LINE[l.kind];
        const at = `${l.date}T10:00:00+04:00`;
        return {
          TransactionId: l.id,
          TransactionDateTime: at,
          BookingDateTime: at,
          ValueDateTime: at,
          TransactionType: shape.type,
          SubTransactionType: shape.sub,
          Flags: shape.flags,
          PaymentModes: 'Online',
          CreditDebitIndicator: l.direction,
          Status: l.status,
          TransactionMutability: 'Immutable',
          TransactionInformation: shape.text,
          Amount: { Amount: dec(l.amountMinor), Currency: 'AED' },
          // The published schema states ExchangeRate as a JSON number. The adapter never reads it.
          ...(l.kind === 'CARD_FX'
            ? {
                CurrencyExchange: {
                  SourceCurrency: 'USD',
                  TargetCurrency: 'AED',
                  UnitCurrency: 'USD',
                  ExchangeRate: 3.6725,
                  InstructedAmount: { Amount: '1000.00', Currency: 'USD' },
                },
              }
            : {}),
        };
      }),
    },
    Links: { Self: e.url, ...(page < pages ? { Next: next.toString() } : {}) },
    Meta: {
      TotalPages: pages,
      FirstAvailableDateTime: '2026-01-01T00:00:00+04:00',
      LastAvailableDateTime: CAST_AS_OF_ISO,
    },
  };
}

// -- Dispatch -----------------------------------------------------------------

/** Every operation a UAE adapter makes, and the rule that answers it. */
export const DEMONSTRATION_OPERATIONS: Readonly<Record<string, Rule>> = {
  'registry.lookup': registryProfile,
  'registry.officers': registryOfficers,
  'registry.psc': registryControllers,
  'identity.verify': identity,
  'bureau.commercial': bureauCommercial,
  'bureau.individual': bureauIndividual,
  'bureau.report': bureauSubmission,
  'tax.registration': taxRegistration,
  'employment.wps': wpsEmployee,
  'employment.wps.establishment': wpsEstablishment,
  'identity.start': authorize,
  'identity.confirm': userinfo,
  'signature.start': signerStart,
  'signature.confirm': signerResult,
  'payments.disburse': paymentStatus(false),
  'payments.collect': paymentStatus(true),
  'openfinance.consent': ofConsent,
  'openfinance.accounts': ofAccounts,
  'openfinance.balances': ofBalances,
  'openfinance.transactions': ofTransactions,
};

export class DemonstrationTransport implements RailTransport {
  /** `now` is the clock the adapters are configured with; UAE Pass and payment times must be fresh against it. */
  constructor(private readonly now: () => number = () => CAST_AS_OF_EPOCH) {}

  async call(operation: string, envelope: RailEnvelope): Promise<Readonly<Record<string, unknown>>> {
    // An operation without a rule is a gap in the demonstration, said plainly rather than answered.
    if (!Object.hasOwn(DEMONSTRATION_OPERATIONS, operation))
      throw new TransportError(operation, 501, `no demonstration rule for ${operation}`);
    const rule = DEMONSTRATION_OPERATIONS[operation] as Rule;
    return Promise.resolve(rule(envelope, this.now()));
  }
}
